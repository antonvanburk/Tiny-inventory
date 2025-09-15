// server.js
const express = require('express');
const path = require('path');
const Groq = require('groq-sdk');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3006;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Controleer API-sleutel
if (!process.env.GROQ_API_KEY) {
  console.warn('LET OP: GROQ_API_KEY is niet ingesteld in .env. AI-functies werken dan niet.');
}

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ---------- HELPERS ----------

function safeNumber(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  // verwijder mogelijke valuta tekens en spaties en vervang komma met punt
  const cleaned = String(v).replace(/€/g, '').replace(/\s/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function generateLowStockReply(inventory = []) {
  const low = (inventory || []).filter(i => safeNumber(i.stock) < safeNumber(i.minStock));
  if (low.length === 0) return 'Er zijn momenteel geen items met een lage voorraad.';
  return low.map(i => `${i.code}, ${i.name}, heeft een lage voorraad van ${safeNumber(i.stock)}.`).join('\n');
}

function generateTotalValueReply(inventory = []) {
  const total = (inventory || []).reduce((acc, i) => {
    const price = safeNumber(i.price);
    const stock = safeNumber(i.stock);
    return acc + price * stock;
  }, 0);
  return `De totale waarde van de inventaris is €${total.toFixed(2)}.`;
}

function generateTotalStockReply(inventory = []) {
  // totale aantallen stuks vorhanden (som van stock)
  const totalUnits = (inventory || []).reduce((acc, i) => acc + safeNumber(i.stock), 0);
  return `De totale voorraad is ${Math.round(totalUnits)} stuks.`;
}

function generateDistinctItemsReply(inventory = []) {
  const distinct = (inventory || []).length;
  return `Er zijn ${distinct} verschillende items in de inventaris.`;
}

// Very small sanitizer/failsafe: zet AI-lists op aparte regels
function ensureNewlinesForLowStockText(text) {
  if (!text || !text.includes('heeft een lage voorraad')) return text;
  // split op zinnen die eindigen met punt gevolgd door spatie en een code-patroon
  const parts = text.split('.').map(s => s.trim()).filter(s => s.length > 0);
  return parts.join('.\n') + (parts.length > 0 ? '.' : '');
}

// ---------- AI / GROQ ----------

async function getGroqChatCompletion(userMessage, inventoryData) {
  const inventoryText = JSON.stringify(inventoryData || [], null, 2);
  const systemPrompt = `
Je bent een AI-assistent voor een inventarisatiesysteem. 
Je krijgt een inventaris als JSON-array van objecten met velden: code, name, category, stock, minStock, price, location.

Huidige inventaris:
${inventoryText}

### Regels die je ALTIJD moet volgen:
1. Je antwoordt ALLEEN in de hieronder beschreven formaten. 
   Je voegt GEEN extra uitleg, beleefdheden of interpretaties toe. 
   Je mag NIET afwijken van de formaten.

2. Acties:
   - TOEVOEGEN: Geef uitsluitend 'TOEVOEGEN: { "code": "...", "naam": "...", "categorie": "...", "voorraad": 0, "minVoorraad": 0, "prijs": 0.00, "locatie": "..." }'
   - BIJWERKEN: Geef uitsluitend 'BIJWERKEN: { "code": "...", "voorraad": ... }'

3. Tekstuele antwoorden:
   - Bij succesvol toevoegen/bijwerken: uitsluitend "Het item is succesvol toegevoegd." of "Het item is succesvol bijgewerkt."
   - Bij mislukken: uitsluitend "Het item kon niet worden toegevoegd omdat de code al bestaat." of "Het item kon niet worden bijgewerkt omdat het niet gevonden is."
   - Bij voorraad aanpassen: uitsluitend "De voorraad van [CODE] is met [AANTAL] verhoogd." of "De voorraad van [CODE] is met [AANTAL] verlaagd."
   - Bij informatieve vragen/berekeningen: uitsluitend korte antwoorden, bv. "De totale waarde van de inventaris is €[BEDRAG]."

4. LAGE VOORRAAD:
   - Als de gebruiker vraagt naar items met lage voorraad:
     * Toon ALLEEN de items waarvoor stock < minStock geldt.
     * Voor ELK item schrijf je een aparte regel, gescheiden door een harde newline (\n).
     * Exact formaat per regel:
       CODE, NAAM, heeft een lage voorraad van [stock].
     * Als er geen items zijn met stock < minStock, antwoord uitsluitend:
       Er zijn momenteel geen items met een lage voorraad.

### Naleving:
Als je niet zeker bent, kies ALTIJD het dichtstbijzijnde juiste formaat in plaats van eigen logica te verzinnen.
`;

  try {
    const response = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      // model kan aangepast worden naar wat in jouw account beschikbaar is
      model: 'llama-3.1-8b-instant',
      temperature: 0.2,
      max_tokens: 600,
    });

    return response.choices[0]?.message?.content || 'Geen reactie van de AI ontvangen.';
  } catch (error) {
    console.error('Fout bij Groq API aanroep:', error);
    return 'Er is een fout opgetreden bij de communicatie met de AI. Controleer je API-sleutel en serverinstellingen.';
  }
}

// ---------- ROUTES ----------

app.post('/api/ai', async (req, res) => {
  try {
    const { message = '', inventory = [] } = req.body;
    const lower = String(message || '').toLowerCase();

    // 1) Detecteer verzoeken die we server-side betrouwbaar beantwoorden moeten:
    const lowStockRegex = /(lage ?voorraad|items met lage voorraad|toon alle items met lage voorraad|laag voorraad)/i;
    const totalValueRegex = /(totale\s+waarde|waarde\s+van\s+de\s+inventaris|hoeveel\s+is\s+de\s+inventaris waard|inventariswaarde|totaal(e)?\s+waarde|hoeveel\s+is\s+.*waarde)/i;
    const totalStockRegex = /(totale\s+voorraad|totaal(e)?\s+voorraad|hoeveel\s+stuks|hoeveel\s+voorraad)/i;
    const distinctItemsRegex = /(hoeveel\s+(verschillende|versch.)\s+items|aantal items|hoeveel items)/i;

    // Lage voorraad -> server-side, exact en betrouwbaar
    if (lowStockRegex.test(lower)) {
      const reply = generateLowStockReply(inventory);
      return res.json({ reply });
    }

    // Totale waarde -> server-side, betrouwbaar
    if (totalValueRegex.test(lower)) {
      const reply = generateTotalValueReply(inventory);
      return res.json({ reply });
    }

    // Totale voorraad (aantal units) -> server-side
    if (totalStockRegex.test(lower)) {
      const reply = generateTotalStockReply(inventory);
      return res.json({ reply });
    }

    // Aantal verschillende items -> server-side
    if (distinctItemsRegex.test(lower)) {
      const reply = generateDistinctItemsReply(inventory);
      return res.json({ reply });
    }

    // 2) Anders: doorsturen naar de AI
    let reply = await getGroqChatCompletion(message, inventory);

    // 3) Failsafe post-processing
    // Zorg dat "heeft een lage voorraad" altijd op aparte regels staat
    reply = ensureNewlinesForLowStockText(reply);

    // Als AI probeerde een berekening te doen maar terugkeek met "€..." in vreemde vorm,
    // we doen geen extra override hier omdat we server-side belangrijke calculaties afhandelen.
    // Retourneer AI-antwoord zoals ontvangen (maar met kleine formatting fixes).
    return res.json({ reply });
  } catch (error) {
    console.error('Fout bij het verwerken van AI-verzoek:', error);
    res.status(500).json({ error: 'Interne serverfout' });
  }
});

// ---------- START SERVER ----------
app.listen(port, () => {
  console.log(`Server draait op http://localhost:${port}`);
});
