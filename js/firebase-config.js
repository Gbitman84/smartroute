// Firebase web app config (project smartrun-gbit). These values are public by design;
// access is protected by firestore.rules (only your signed-in account).
// Set to null to run in DEMO mode (data kept only in this browser – for testing).
export const firebaseConfig = {
  apiKey: 'AIzaSyCDTUNXA7o1jZo2quZ1bBhNj7SK5yjf8fE',
  authDomain: 'smartrun-gbit.firebaseapp.com',
  projectId: 'smartrun-gbit',
  storageBucket: 'smartrun-gbit.firebasestorage.app',
  messagingSenderId: '265332673817',
  appId: '1:265332673817:web:128578d24c66ba4f87c988',
};

// Google Maps key for precise address lookup (Geocoding). Restricted to gbitman84.github.io + localhost:8765,
// capped at 300 lookups/day in Google Cloud. Set to '' to fall back to OpenStreetMap.
export const googleMapsKey = 'AIzaSyANkJk2YZExpz3JF7InlHHPWa4-V0GbBIw';

// SmartRoute (lab): separate site + separate data area in the same Firebase project.
export const appInfo = { name: 'SmartRoute', lab: true, dataRoot: 'labUsers', functionsRegion: 'europe-west1' };

// Invite-only sign-up. The superadmin (also enforced in firestore.rules) is always allowed in;
// siteUrl is the public address used in referral / registration links.
export const access = { superadmin: 'gbitman.bd@gmail.com', siteUrl: 'https://gbitman84.github.io/smartroute/' };
