# lead-score-elev

Lead scoring Cloud Function för Musikglädjen. Beräknar avstånd mellan nya elevanmälningar och tillgängliga lärare.

## Vad den gör

1. Tar emot en elevs adress
2. Geocodar adressen till koordinater (Google Geocoding API)
3. Hämtar alla aktiva lärare från Airtable
4. Beräknar fågelvägsavstånd till alla lärare (Haversine-formel)
5. Hämtar cykeltid för de 5 närmaste (Google Distance Matrix API)
6. Returnerar lead score (A/B/C) och detaljdata

## Setup i Google Cloud

### 1. Miljövariabler

Sätt dessa i Cloud Function-konfigurationen:

| Variabel | Beskrivning |
|----------|-------------|
| `GOOGLE_API_KEY` | API-nyckel med Geocoding + Distance Matrix aktiverat |
| `AIRTABLE_API_KEY` | Din Airtable API-nyckel |
| `AIRTABLE_BASE_ID` | Base ID (börjar med "app...") |
| `AUTH_SECRET` | Valfritt lösenord för att skydda endpointen |

### 2. Cloud Function-inställningar

- **Runtime:** Node.js 20
- **Entry point:** `leadScoreElev`
- **Region:** europe-west1 (rekommenderat för Sverige)
- **Trigger:** HTTPS

## Anpassa för din Airtable

Ändra dessa värden i `index.js` om dina tabeller/fält heter annorlunda:

```javascript
TEACHERS_TABLE: 'Lärare',
TEACHER_ADDRESS_FIELD: 'Adress',
TEACHER_LAT_FIELD: 'Latitude',
TEACHER_LNG_FIELD: 'Longitude',
TEACHER_ACTIVE_FIELD: 'Aktiv',
```

## API-anrop från Make

**URL:** Din Cloud Function URL  
**Method:** POST  
**Headers:**
```
Authorization: Bearer DITT_AUTH_SECRET
Content-Type: application/json
```

**Body:**
```json
{
  "student_address": "Sveavägen 10, Stockholm",
  "student_record_id": "recXXXXXX"
}
```

## Svar

```json
{
  "student_lat": 59.334591,
  "student_lng": 18.063240,
  "student_formatted_address": "Sveavägen 10, 111 57 Stockholm, Sweden",
  "nearest_teacher_id": "rec123abc",
  "nearest_teacher_name": "Anna Andersson",
  "nearest_distance_km": 2.3,
  "nearest_bike_time_min": 11,
  "top3_avg_distance_km": 4.1,
  "teachers_within_5km": 3,
  "lead_score": "A",
  "top5_teachers": [...]
}
```

## Lead Score-trösklar

Nuvarande trösklar (ändra i koden efter behov):

- **A:** Närmaste lärare ≤ 3 km
- **B:** Närmaste lärare 3-7 km
- **C:** Närmaste lärare > 7 km
