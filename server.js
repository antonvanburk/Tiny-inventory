const express = require('express');
const path = require('path');
const Groq = require('groq-sdk');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3006;

app.use(express.json());

// AANGEPASTE CODE: Serveert statische bestanden vanuit de hoofdmap
app.use(express.static(path.join(__dirname)));

// Deze route stuurt de index.html file naar de browser vanuit de hoofdmap
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Dit haalt de API-sleutel op uit het .env bestand
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function getGroqChatCompletion(userMessage, inventoryData) {
    const inventoryText = JSON.stringify(inventoryData, null, 2);
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
       - TOEVOEGEN: Geef uitsluitend 'TOEVOEG: { "code": "...", "naam": "...", "categorie": "...", "voorraad": 0, "minVoorraad": 0, "prijs": 0.00, "locatie": "..." }'
       - BIJWERKEN: Geef uitsluitend 'BIJWERKEN: { "code": "...", "voorraad": ... }'
    
    3. Tekstuele antwoorden:
       - Bij succesvol toevoegen/bijwerken: uitsluitend "Het item is succesvol toegevoegd." of "Het item is succesvol bijgewerkt."
       - Bij mislukken: uitsluitend "Het item kon niet worden toegevoegd omdat de code al bestaat." of "Het item kon niet worden bijgewerkt omdat het niet gevonden is."
       - Bij voorraad aanpassen: uitsluitend "De voorraad van [CODE] is met [AANTAL] verhoogd." of "De voorraad van [CODE] is met [AANTAL] verlaagd."
       - Bij informatieve vragen/berekeningen: uitsluitend korte antwoorden, bv. "De totale waarde van de inventaris is €[BEDRAG]."
    
    4. LAGE VOORRAAD:
       - Als de gebruiker vraagt naar items met lage voorraad, toon ALLEEN de items waarvoor **stock < minStock** geldt.
       - Gebruik exact dit formaat per item (één per regel):
         CODE, NAAM, heeft een lage voorraad van [stock].
       - Als er geen items zijn met stock < minStock, antwoord uitsluitend met:
         "Er zijn momenteel geen items met een lage voorraad."
    
    ### Naleving:
    Als je niet zeker bent, kies ALTIJD het dichtstbijzijnde juiste formaat in plaats van eigen logica te verzinnen.
    `;
    
    try {
        const response = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ],
            model: 'llama3-70b-8192',
            temperature: 0.5,
            max_tokens: 500,
        });
        
        return response.choices[0]?.message?.content || 'Geen reactie van de AI ontvangen.';
    } catch (error) {
        console.error('Fout bij Groq API aanroep:', error);
        return 'Er is een fout opgetreden bij de communicatie met de AI. Controleer je API-sleutel en serverinstellingen.';
    }
}

app.post('/api/ai', async (req, res) => {
    try {
        const { message, inventory } = req.body;
        const reply = await getGroqChatCompletion(message, inventory);
        res.json({ reply });
    } catch (error) {
        console.error('Fout bij het verwerken van AI-verzoek:', error);
        res.status(500).json({ error: 'Interne serverfout' });
    }
});

app.listen(port, () => {
    console.log(`Server draait op http://localhost:${port}`);
});
