// OB Sommelier runtime config.
// Leave SUPABASE_URL / SUPABASE_ANON_KEY empty to run on /data/demo.json (demo mode).
// Live: Supabase project ob-sommelier-pilot. The anon key is public by design; Row Level Security protects the data.
// Never put the service_role key here.
window.OB_CONFIG = {
  SUPABASE_URL: 'https://guubvljneicnepzwehet.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1dWJ2bGpuZWljbmVwendlaGV0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxMTYxMzIsImV4cCI6MjEwNzY5MjEzMn0.1CMQmPg1T-8zttznY51KHd4bVh_ndi3xJ0khDJG_10I',
  DEFAULT_CENTER: { lat: 12.5186, lng: -70.0358, label: 'Oranjestad' },
  DEFAULT_RADIUS_KM: 10,
  STALE_AFTER_DAYS: 30,          // store prices not confirmed in this window are hidden; shelf sightings turn amber
  MIN_AGE: 18,                   // Aruba legal drinking age
  ADS_ENABLED: true,             // house ads (vendor promos); no third-party ad network
  INTERSTITIAL_MIN_GAP_MIN: 20,  // never more often than this
  INTERSTITIAL_AFTER_SEARCHES: 3 // never on launch; only after N completed searches
};
