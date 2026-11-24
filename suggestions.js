// suggestions.js
// Kinds of charge that usually belong to a category of a given name.
// When someone names a new category, these are offered first, already
// ticked, for them to confirm or reject. Nothing is applied without that.
//
// Each entry: the words that trigger it, and the kinds it suggests.
// The kind codes are Plaid's detailed personal finance categories.

const SUGGESTIONS = [
  {
    words: ['kids', 'kid', 'children', 'child', 'childcare', 'daycare', 'baby', 'nanny'],
    kinds: ['GENERAL_SERVICES_CHILDCARE', 'GENERAL_SERVICES_EDUCATION'],
  },
  {
    words: ['school', 'education', 'tuition', 'classes', 'lessons', 'learning'],
    kinds: ['GENERAL_SERVICES_EDUCATION'],
  },
  {
    words: ['health', 'healthcare', 'medical', 'doctor', 'doctors', 'wellness'],
    kinds: [
      'MEDICAL_PRIMARY_CARE',
      'MEDICAL_DENTAL_CARE',
      'MEDICAL_EYE_CARE',
      'MEDICAL_PHARMACIES_AND_SUPPLEMENTS',
      'MEDICAL_NURSING_CARE',
    ],
  },
  {
    words: ['pharmacy', 'medicine', 'prescriptions'],
    kinds: ['MEDICAL_PHARMACIES_AND_SUPPLEMENTS'],
  },
  { words: ['dentist', 'dental'], kinds: ['MEDICAL_DENTAL_CARE'] },
  {
    words: ['pets', 'pet', 'dog', 'dogs', 'cat', 'cats', 'vet'],
    kinds: ['GENERAL_MERCHANDISE_PET_SUPPLIES', 'MEDICAL_VETERINARY_SERVICES'],
  },
  { words: ['coffee', 'cafe', 'cafes'], kinds: ['FOOD_AND_DRINK_COFFEE'] },
  {
    words: ['bills', 'utilities', 'utility'],
    kinds: [
      'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY',
      'RENT_AND_UTILITIES_INTERNET_AND_CABLE',
      'RENT_AND_UTILITIES_TELEPHONE',
      'RENT_AND_UTILITIES_WATER',
      'RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT',
    ],
  },
  {
    words: ['phone', 'phones', 'internet', 'wifi', 'cable', 'mobile'],
    kinds: ['RENT_AND_UTILITIES_TELEPHONE', 'RENT_AND_UTILITIES_INTERNET_AND_CABLE'],
  },
  { words: ['rent', 'housing'], kinds: ['RENT_AND_UTILITIES_RENT'] },
  {
    words: ['home', 'house', 'furniture', 'repairs', 'maintenance'],
    kinds: [
      'HOME_IMPROVEMENT_FURNITURE',
      'HOME_IMPROVEMENT_HARDWARE',
      'HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE',
      'HOME_IMPROVEMENT_SECURITY',
    ],
  },
  {
    words: ['fitness', 'gym', 'exercise', 'workout', 'sports', 'sport'],
    kinds: ['PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS', 'GENERAL_MERCHANDISE_SPORTING_GOODS'],
  },
  {
    words: ['beauty', 'hair', 'grooming', 'salon', 'self care', 'personal care'],
    kinds: ['PERSONAL_CARE_HAIR_AND_BEAUTY'],
  },
  {
    words: ['laundry', 'dry cleaning', 'cleaners'],
    kinds: ['PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING'],
  },
  {
    words: ['gifts', 'gift', 'presents'],
    kinds: ['GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES'],
  },
  {
    words: ['giving', 'donations', 'donation', 'charity', 'church', 'tithe'],
    kinds: ['GOVERNMENT_AND_NON_PROFIT_DONATIONS'],
  },
  {
    words: ['subscriptions', 'subscription', 'streaming', 'media'],
    kinds: ['ENTERTAINMENT_TV_AND_MOVIES', 'ENTERTAINMENT_MUSIC_AND_AUDIO'],
  },
  { words: ['games', 'gaming'], kinds: ['ENTERTAINMENT_VIDEO_GAMES'] },
  { words: ['insurance'], kinds: ['GENERAL_SERVICES_INSURANCE'] },
  {
    words: ['car', 'cars', 'auto', 'fuel', 'gas'],
    kinds: [
      'TRANSPORTATION_GAS',
      'GENERAL_SERVICES_AUTOMOTIVE',
      'TRANSPORTATION_PARKING',
      'TRANSPORTATION_TOLLS',
    ],
  },
  {
    words: ['commute', 'transit', 'subway', 'rides', 'taxi', 'taxis'],
    kinds: ['TRANSPORTATION_PUBLIC_TRANSIT', 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES'],
  },
  {
    words: ['clothes', 'clothing', 'fashion', 'apparel'],
    kinds: ['GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES'],
  },
  { words: ['books', 'reading'], kinds: ['GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS'] },
  { words: ['electronics', 'tech', 'gadgets'], kinds: ['GENERAL_MERCHANDISE_ELECTRONICS'] },
  {
    words: ['alcohol', 'drinks', 'bar', 'bars', 'wine', 'liquor'],
    kinds: ['FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR'],
  },
  {
    words: ['eating out', 'restaurants', 'restaurant', 'takeout', 'delivery'],
    kinds: ['FOOD_AND_DRINK_RESTAURANT', 'FOOD_AND_DRINK_FAST_FOOD'],
  },
  {
    words: ['fees', 'interest'],
    kinds: [
      'BANK_FEES_INTEREST_CHARGE',
      'BANK_FEES_ATM_FEES',
      'BANK_FEES_FOREIGN_TRANSACTION_FEES',
    ],
  },
  { words: ['taxes', 'tax'], kinds: ['GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT'] },
  {
    words: ['legal', 'lawyer', 'accountant', 'professional'],
    kinds: [
      'GENERAL_SERVICES_CONSULTING_AND_LEGAL',
      'GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING',
    ],
  },
  {
    words: ['flights', 'flight', 'hotels', 'hotel', 'vacation', 'vacations', 'trips', 'trip'],
    kinds: ['TRAVEL_FLIGHTS', 'TRAVEL_LODGING', 'TRAVEL_RENTAL_CARS'],
  },
  { words: ['shipping', 'postage'], kinds: ['GENERAL_SERVICES_POSTAGE_AND_SHIPPING'] },
  { words: ['storage'], kinds: ['GENERAL_SERVICES_STORAGE'] },
];

// 'Kids & school' -> the set of kinds suggested for that name.
// A word must match whole, so "car" does not fire on "care".
function suggestedKindsFor(name) {
  const text = ` ${String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
  const found = new Set();
  for (const entry of SUGGESTIONS) {
    if (entry.words.some((w) => text.includes(` ${w} `))) {
      entry.kinds.forEach((k) => found.add(k));
    }
  }
  return found;
}

module.exports = { suggestedKindsFor };