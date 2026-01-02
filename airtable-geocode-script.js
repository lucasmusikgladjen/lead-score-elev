/**
 * GEOCODING SCRIPT FÖR AIRTABLE AUTOMATIONS
 * 
 * Användning:
 * 1. Skapa en Automation i Airtable
 * 2. Trigger: "When record is created" ELLER "When record is updated" (på adressfältet)
 * 3. Action: "Run script"
 * 4. Klistra in denna kod
 * 5. Konfigurera input variables (se nedan)
 * 
 * Input variables att konfigurera i Airtable:
 * - record_id: Record ID från triggern
 * - address: Värdet från fältet "Sammansatt adress"
 * - google_api_key: Din Google API-nyckel (lägg som secret)
 */

// ============ KONFIGURATION ============
// Fältnamn - ändra om dina fält heter annorlunda
const LAT_FIELD = 'Latitude';
const LNG_FIELD = 'Longitude';

// ============ SCRIPT ============

const config = input.config();

const recordId = config.record_id;
const address = config.address;
const apiKey = config.google_api_key;

// Validera input
if (!address || address.trim() === '') {
    console.log('Ingen adress angiven, hoppar över geocoding');
    return;
}

if (!apiKey) {
    console.error('Google API-nyckel saknas!');
    return;
}

// Geocoda adressen
const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&region=se&key=${apiKey}`;

console.log(`Geocoding: ${address}`);

const response = await fetch(url);
const data = await response.json();

if (data.status !== 'OK' || !data.results[0]) {
    console.error(`Geocoding failed: ${data.status}`);
    console.error(`Address: ${address}`);
    if (data.error_message) {
        console.error(`Error: ${data.error_message}`);
    }
    return;
}

const location = data.results[0].geometry.location;
const lat = location.lat;
const lng = location.lng;
const formattedAddress = data.results[0].formatted_address;

console.log(`Resultat: ${formattedAddress}`);
console.log(`Koordinater: ${lat}, ${lng}`);

// Uppdatera recorden med koordinater
const table = base.getTable(config.table_name || 'Lärare');

await table.updateRecordAsync(recordId, {
    [LAT_FIELD]: lat,
    [LNG_FIELD]: lng,
});

console.log('✓ Koordinater sparade!');
