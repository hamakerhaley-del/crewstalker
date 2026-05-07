// Run this ONCE to generate your push notification keys
// Command: node generate-vapid-keys.js
// Then paste the output into your Railway environment variables

const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();

console.log('\n=== CrewStalker VAPID Keys ===');
console.log('Copy these into Railway environment variables:\n');
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
console.log('\nAlso paste VAPID_PUBLIC_KEY into your frontend .env file');
console.log('==============================\n');
