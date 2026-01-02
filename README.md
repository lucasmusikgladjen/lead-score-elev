# lead-score-elev

Lead scoring Cloud Function för Musikglädjen. Beräknar avstånd mellan nya elevanmälningar och tillgängliga lärare/jobbansökningar.

## Vad den gör

1. Tar emot en elevs adress
2. Geocodar adressen till koordinater (Google Geocoding API)
3. Hämtar alla från **Lärare**-tabellen
4. Hämtar alla från **Jobbansökningar**-tabellen (exkl. Okvalificerad/Refuserad)
5. Deduplicerar baserat på mejladress (samma person i båda → visas bara en gång)
6. Beräknar fågelvägsavstånd (Haversine) + cykeltid (Distance Matrix)
7. Returnerar **separata resultat** för lärare och ansökningar

---

## Del 1: Cloud Function Setup

### Miljövariabler i Google Cloud

| Variabel | Beskrivning |
|----------|-------------|
| `GOOGLE_API_KEY` | API-nyckel med Geocoding + Distance Matrix |
| `AIRTABLE_API_KEY` | Din Airtable API-nyckel |
| `AIRTABLE_BASE_ID` | Base ID (börjar med "app...") |
| `AUTH_SECRET` | Valfritt lösenord för att skydda endpointen |

### Cloud Function-inställningar

- **Runtime:** Node.js 20
- **Entry point:** `leadScoreElev`
- **Region:** europe-west1

### Exempel-svar från API:et

```json
{
  "student_lat": 59.334591,
  "student_lng": 18.063240,
  "student_formatted_address": "Sveavägen 10, 111 57 Stockholm, Sweden",
  "lead_score": "A",
  
  "teachers": {
    "nearest": {
      "id": "rec123",
      "name": "Anna Andersson",
      "email": "anna@example.com",
      "haversine_km": 2.3,
      "bike_time_minutes": 11,
      "bike_distance_km": 3.1
    },
    "top5": [...],
    "count_within_5km": 3,
    "total_count": 15
  },
  
  "applicants": {
    "nearest": {
      "id": "rec456",
      "name": "Erik Eriksson",
      "email": "erik@example.com",
      "haversine_km": 1.8,
      "bike_time_minutes": 8,
      "bike_distance_km": 2.4
    },
    "top5": [...],
    "count_within_5km": 2,
    "total_count": 8
  }
}
```

---

## Del 2: Airtable Geocoding Automation

Innan lead scoring fungerar måste lärare och ansökningar ha koordinater. Sätt upp en automation som geocodar nya/uppdaterade adresser.

### Setup för varje tabell (Lärare + Jobbansökningar)

1. **Gå till Automations** i din Airtable-base
2. **Skapa ny automation**
3. **Trigger:** "When record is created" eller "When record matches conditions"
   - Condition: `Sammansatt adress` is not empty AND `Latitude` is empty
4. **Action:** "Run script"
5. **Klistra in koden** från `airtable-geocode-script.js`

### Input variables att konfigurera

Klicka på "Add input variable" och lägg till:

| Variable name | Value |
|---------------|-------|
| `record_id` | Record ID (från triggern) |
| `address` | `{Sammansatt adress}` (från triggern) |
| `table_name` | `Lärare` eller `Jobbansökningar` |
| `google_api_key` | Din Google API-nyckel (markera som "secret") |

### Backfill av befintliga records

För att geocoda alla befintliga lärare/ansökningar som saknar koordinater:

1. Skapa en vy som filtrerar på: `Latitude` is empty AND `Sammansatt adress` is not empty
2. Kör automationen manuellt på dessa, eller:
3. Lägg till ett dummy-fält, uppdatera det för alla records (triggar automationen)

---

## Lead Score-trösklar

Nuvarande trösklar (baseras på närmaste person oavsett källa):

| Score | Kriterium |
|-------|-----------|
| **A** | Närmaste ≤ 3 km |
| **B** | Närmaste 3-7 km |
| **C** | Närmaste > 7 km |

Ändra i `calculateLeadScore()` i `index.js` efter behov.

---

## Fältnamn i Airtable

Koden förväntar sig dessa fält i båda tabellerna:

| Fält | Typ |
|------|-----|
| `Name` | Single line text |
| `E-post` | Email |
| `Sammansatt adress` | Single line text / Formula |
| `Latitude` | Number |
| `Longitude` | Number |
| `Status` | Single select (endast Jobbansökningar) |

Om dina fält heter annorlunda, uppdatera CONFIG i `index.js`.
