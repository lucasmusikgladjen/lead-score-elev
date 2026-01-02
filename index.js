const Airtable = require('airtable');

// ============ KONFIGURATION ============
const CONFIG = {
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  AUTH_SECRET: process.env.AUTH_SECRET,

  // Tabeller
  TEACHERS_TABLE: 'Lärare',
  APPLICATIONS_TABLE: 'Jobbansökningar',

  // Fältnamn (samma i båda tabellerna)
  ADDRESS_FIELD: 'Sammansatt adress',
  LAT_FIELD: 'Latitude',
  LNG_FIELD: 'Longitude',
  EMAIL_FIELD: 'E-post',
  STATUS_FIELD: 'Status',

  // Statusar att exkludera från Jobbansökningar
  EXCLUDED_STATUSES: ['Okvalificerad', 'Refuserad'],
};

// ============ HJÄLPFUNKTIONER ============

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

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
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

async function getBikeTimes(originLat, originLng, people) {
  if (people.length === 0) return [];

  const destinations = people.map((p) => `${p.lat},${p.lng}`).join('|');

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${originLat},${originLng}&destinations=${destinations}&mode=bicycling&key=${CONFIG.GOOGLE_API_KEY}`;

  const response = await fetch(url);
  const data = await response.json();

  if (data.status !== 'OK') {
    throw new Error(`Distance Matrix failed: ${data.status}`);
  }

  return data.rows[0].elements.map((element, index) => ({
    bike_time_minutes:
      element.status === 'OK' ? Math.round(element.duration.value / 60) : null,
    bike_distance_km:
      element.status === 'OK'
        ? parseFloat((element.distance.value / 1000).toFixed(2))
        : null,
  }));
}

/**
 * Hämta personer från en Airtable-tabell
 */
async function getPeopleFromTable(base, tableName, filterFormula = null) {
  const people = [];

  const queryOptions = {
    fields: [
      'Name',
      CONFIG.ADDRESS_FIELD,
      CONFIG.LAT_FIELD,
      CONFIG.LNG_FIELD,
      CONFIG.EMAIL_FIELD,
    ],
  };

  if (filterFormula) {
    queryOptions.filterByFormula = filterFormula;
  }

  await base(tableName)
    .select(queryOptions)
    .eachPage((records, fetchNextPage) => {
      records.forEach((record) => {
        const lat = record.get(CONFIG.LAT_FIELD);
        const lng = record.get(CONFIG.LNG_FIELD);
        const email = record.get(CONFIG.EMAIL_FIELD);

        if (lat && lng) {
          people.push({
            id: record.id,
            name: record.get('Name'),
            email: email ? email.toLowerCase().trim() : null,
            address: record.get(CONFIG.ADDRESS_FIELD),
            lat: parseFloat(lat),
            lng: parseFloat(lng),
            source: tableName,
          });
        }
      });
      fetchNextPage();
    });

  return people;
}

/**
 * Hämta alla lärare och ansökningar, deduplicera på mejl
 */
async function getAllTeachersAndApplicants() {
  const base = new Airtable({ apiKey: CONFIG.AIRTABLE_API_KEY }).base(
    CONFIG.AIRTABLE_BASE_ID
  );

  // Hämta från Lärare (ingen statusfiltrering)
  console.log('Fetching from Lärare...');
  const teachers = await getPeopleFromTable(base, CONFIG.TEACHERS_TABLE);
  console.log(`Found ${teachers.length} teachers with coordinates`);

  // Hämta från Jobbansökningar (exkludera Okvalificerad och Refuserad)
  const excludeFormula = `AND(NOT({${CONFIG.STATUS_FIELD}} = "Okvalificerad"), NOT({${CONFIG.STATUS_FIELD}} = "Refuserad"))`;
  console.log('Fetching from Jobbansökningar...');
  const applicants = await getPeopleFromTable(
    base,
    CONFIG.APPLICATIONS_TABLE,
    excludeFormula
  );
  console.log(`Found ${applicants.length} applicants with coordinates`);

  // Samla mejladresser från Lärare för deduplicering
  const teacherEmails = new Set(
    teachers.filter((t) => t.email).map((t) => t.email)
  );

  // Filtrera bort ansökningar som redan finns som lärare (baserat på mejl)
  const uniqueApplicants = applicants.filter((a) => {
    if (!a.email) return true; // Behåll om ingen mejl (kan inte deduplicera)
    return !teacherEmails.has(a.email);
  });

  const duplicatesRemoved = applicants.length - uniqueApplicants.length;
  if (duplicatesRemoved > 0) {
    console.log(
      `Removed ${duplicatesRemoved} duplicate applicants (already in Lärare)`
    );
  }

  return { teachers, applicants: uniqueApplicants };
}

/**
 * Beräkna avstånd och cykeltider för en grupp personer
 */
async function calculateDistances(studentLat, studentLng, people, label) {
  if (people.length === 0) {
    return {
      nearest: null,
      top5: [],
      count_within_5km: 0,
    };
  }

  // Räkna Haversine-avstånd
  const withDistance = people.map((person) => ({
    ...person,
    haversine_km: haversineDistance(
      studentLat,
      studentLng,
      person.lat,
      person.lng
    ),
  }));

  // Sortera efter avstånd
  withDistance.sort((a, b) => a.haversine_km - b.haversine_km);

  // Hämta cykeltid för de 5 närmaste
  const top5 = withDistance.slice(0, 5);
  console.log(`Getting bike times for top ${top5.length} ${label}...`);
  const bikeTimes = await getBikeTimes(studentLat, studentLng, top5);

  // Kombinera data
  const top5WithBikeTimes = top5.map((person, index) => ({
    id: person.id,
    name: person.name,
    email: person.email,
    haversine_km: Math.round(person.haversine_km * 10) / 10,
    bike_time_minutes: bikeTimes[index]?.bike_time_minutes || null,
    bike_distance_km: bikeTimes[index]?.bike_distance_km || null,
  }));

  const nearest = top5WithBikeTimes[0];
  const countWithin5km = withDistance.filter((p) => p.haversine_km <= 5).length;

  return {
    nearest,
    top5: top5WithBikeTimes,
    count_within_5km: countWithin5km,
  };
}

/**
 * Beräkna lead score baserat på närmaste person (oavsett källa)
 */
function calculateLeadScore(teacherNearest, applicantNearest) {
  // Hitta den absolut närmaste
  let nearestDistance = Infinity;

  if (teacherNearest) {
    nearestDistance = Math.min(nearestDistance, teacherNearest.haversine_km);
  }
  if (applicantNearest) {
    nearestDistance = Math.min(nearestDistance, applicantNearest.haversine_km);
  }

  if (nearestDistance <= 3) return 'A';
  if (nearestDistance <= 7) return 'B';
  return 'C';
}

// ============ HUVUDFUNKTION ============

exports.leadScoreElev = async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).send('');
  }

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

    // Steg 2: Hämta alla lärare och ansökningar
    const { teachers, applicants } = await getAllTeachersAndApplicants();

    // Steg 3: Beräkna avstånd för varje grupp separat
    const teacherResults = await calculateDistances(
      studentCoords.lat,
      studentCoords.lng,
      teachers,
      'teachers'
    );

    const applicantResults = await calculateDistances(
      studentCoords.lat,
      studentCoords.lng,
      applicants,
      'applicants'
    );

    // Steg 4: Beräkna overall lead score
    const lead_score = calculateLeadScore(
      teacherResults.nearest,
      applicantResults.nearest
    );

    // Returnera resultat
    const result = {
      // Elevens koordinater
      student_lat: studentCoords.lat,
      student_lng: studentCoords.lng,
      student_formatted_address: studentCoords.formatted_address,

      // Overall lead score
      lead_score,

      // Resultat från Lärare-tabellen
      teachers: {
        nearest: teacherResults.nearest,
        top5: teacherResults.top5,
        count_within_5km: teacherResults.count_within_5km,
        total_count: teachers.length,
      },

      // Resultat från Jobbansökningar-tabellen (exkl. dubbletter)
      applicants: {
        nearest: applicantResults.nearest,
        top5: applicantResults.top5,
        count_within_5km: applicantResults.count_within_5km,
        total_count: applicants.length,
      },
    };

    console.log('Result:', JSON.stringify(result, null, 2));
    return res.json(result);
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
