const Airtable = require('airtable');

// ============ KONFIGURATION ============
// Dessa värden sätts som miljövariabler i Google Cloud Console
const CONFIG = {
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  AUTH_SECRET: process.env.AUTH_SECRET,

  // Tabellnamn i Airtable - JUSTERA DESSA efter din setup
  TEACHERS_TABLE: 'Lärare',

  // Fältnamn i Airtable - JUSTERA DESSA efter din setup
  TEACHER_ADDRESS_FIELD: 'Adress',
  TEACHER_LAT_FIELD: 'Latitude',
  TEACHER_LNG_FIELD: 'Longitude',
  TEACHER_ACTIVE_FIELD: 'Aktiv',
};

// ============ HJÄLPFUNKTIONER ============

/**
 * Geocoda adress till koordinater via Google Geocoding API
 */
async function geocodeAddress(address) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&region=se&key=${CONFIG.GOOGLE_API_KEY}`;

  const response = await fetch(url);
  const data = await response.json();

  if (data.status !== 'OK' || !data.results[0]) {
    throw new Error(`Geocoding failed for "${address}": ${data.status}`);
  }

  const location = data.results[0].geometry.location;
  return {
    lat: location.lat,
    lng: location.lng,
    formatted_address: data.results[0].formatted_address,
  };
}

/**
 * Haversine-formel: räkna avstånd mellan två koordinater (km)
 * Fågelvägsavstånd - gratis, körs lokalt
 */
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Jordens radie i km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Hämta cykeltider från Distance Matrix API
 * Kostar API-tokens så vi kör bara på de närmaste lärarna
 */
async function getBikeTimes(originLat, originLng, teachers) {
  if (teachers.length === 0) return [];

  const destinations = teachers.map((t) => `${t.lat},${t.lng}`).join('|');

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${originLat},${originLng}&destinations=${destinations}&mode=bicycling&key=${CONFIG.GOOGLE_API_KEY}`;

  const response = await fetch(url);
  const data = await response.json();

  if (data.status !== 'OK') {
    throw new Error(`Distance Matrix failed: ${data.status}`);
  }

  return data.rows[0].elements.map((element, index) => ({
    teacher_id: teachers[index].id,
    teacher_name: teachers[index].name,
    bike_time_seconds: element.status === 'OK' ? element.duration.value : null,
    bike_time_minutes:
      element.status === 'OK' ? Math.round(element.duration.value / 60) : null,
    bike_distance_km:
      element.status === 'OK'
        ? (element.distance.value / 1000).toFixed(2)
        : null,
  }));
}

/**
 * Hämta alla aktiva lärare från Airtable som har koordinater
 */
async function getTeachersFromAirtable() {
  const base = new Airtable({ apiKey: CONFIG.AIRTABLE_API_KEY }).base(
    CONFIG.AIRTABLE_BASE_ID
  );

  const teachers = [];

  await base(CONFIG.TEACHERS_TABLE)
    .select({
      filterByFormula: `{${CONFIG.TEACHER_ACTIVE_FIELD}} = TRUE()`,
      fields: [
        'Name',
        CONFIG.TEACHER_ADDRESS_FIELD,
        CONFIG.TEACHER_LAT_FIELD,
        CONFIG.TEACHER_LNG_FIELD,
      ],
    })
    .eachPage((records, fetchNextPage) => {
      records.forEach((record) => {
        const lat = record.get(CONFIG.TEACHER_LAT_FIELD);
        const lng = record.get(CONFIG.TEACHER_LNG_FIELD);

        if (lat && lng) {
          teachers.push({
            id: record.id,
            name: record.get('Name'),
            address: record.get(CONFIG.TEACHER_ADDRESS_FIELD),
            lat: parseFloat(lat),
            lng: parseFloat(lng),
          });
        }
      });
      fetchNextPage();
    });

  return teachers;
}

// ============ HUVUDFUNKTION ============
// Entry point för Cloud Function

exports.leadScoreElev = async (req, res) => {
  // CORS-headers för att tillåta anrop från Make
  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).send('');
  }

  // Enkel autentisering via Bearer token
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${CONFIG.AUTH_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { student_address, student_record_id } = req.body;

    if (!student_address) {
      return res.status(400).json({ error: 'student_address is required' });
    }

    // Steg 1: Geocoda elevens adress
    console.log(`Geocoding: ${student_address}`);
    const studentCoords = await geocodeAddress(student_address);

    // Steg 2: Hämta alla lärare
    console.log('Fetching teachers from Airtable...');
    const teachers = await getTeachersFromAirtable();
    console.log(`Found ${teachers.length} active teachers with coordinates`);

    if (teachers.length === 0) {
      return res.json({
        student_lat: studentCoords.lat,
        student_lng: studentCoords.lng,
        student_formatted_address: studentCoords.formatted_address,
        error: 'No teachers with coordinates found',
        lead_score: 'C',
      });
    }

    // Steg 3: Räkna Haversine-avstånd till alla lärare
    const teachersWithDistance = teachers.map((teacher) => ({
      ...teacher,
      haversine_km: haversineDistance(
        studentCoords.lat,
        studentCoords.lng,
        teacher.lat,
        teacher.lng
      ),
    }));

    // Sortera efter avstånd (närmast först)
    teachersWithDistance.sort((a, b) => a.haversine_km - b.haversine_km);

    // Steg 4: Hämta cykeltid för de 5 närmaste
    const top5 = teachersWithDistance.slice(0, 5);
    console.log(`Getting bike times for top ${top5.length} teachers...`);
    const bikeTimes = await getBikeTimes(
      studentCoords.lat,
      studentCoords.lng,
      top5
    );

    // Kombinera Haversine-data med cykeltider
    const top5WithBikeTimes = top5.map((teacher, index) => ({
      teacher_id: teacher.id,
      teacher_name: teacher.name,
      haversine_km: Math.round(teacher.haversine_km * 10) / 10,
      bike_time_minutes: bikeTimes[index]?.bike_time_minutes || null,
      bike_distance_km: bikeTimes[index]?.bike_distance_km || null,
    }));

    // Steg 5: Beräkna score-data
    const nearest = top5WithBikeTimes[0];
    const top3 = top5WithBikeTimes.slice(0, 3);
    const avgTop3Distance =
      top3.reduce((sum, t) => sum + t.haversine_km, 0) / top3.length;
    const teachersWithin5km = teachersWithDistance.filter(
      (t) => t.haversine_km <= 5
    ).length;

    // Beräkna lead score baserat på avstånd
    // Du kan justera dessa trösklar efter eget behov
    let lead_score;
    if (nearest.haversine_km <= 3) {
      lead_score = 'A';
    } else if (nearest.haversine_km <= 7) {
      lead_score = 'B';
    } else {
      lead_score = 'C';
    }

    // Returnera komplett resultat
    const result = {
      // Elevens koordinater (spara i Airtable för framtida matchning)
      student_lat: studentCoords.lat,
      student_lng: studentCoords.lng,
      student_formatted_address: studentCoords.formatted_address,

      // Närmaste lärare
      nearest_teacher_id: nearest.teacher_id,
      nearest_teacher_name: nearest.teacher_name,
      nearest_distance_km: nearest.haversine_km,
      nearest_bike_time_min: nearest.bike_time_minutes,

      // Aggregerad data
      top3_avg_distance_km: Math.round(avgTop3Distance * 10) / 10,
      teachers_within_5km: teachersWithin5km,

      // Lead score
      lead_score: lead_score,

      // Detaljdata för de 5 närmaste (användbart för debugging/analys)
      top5_teachers: top5WithBikeTimes,
    };

    console.log('Result:', JSON.stringify(result, null, 2));
    return res.json(result);
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
