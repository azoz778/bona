// Listing copy that is NOT a contact detail or another brand: real phrasing from developer brochures
// and Bona listings that sits close to a phone, domain or handle rule. Shared by the rules test
// (services/intake/test/curate.test.mjs), the intake's copy check (services/intake/test/claude.test.mjs)
// and the site validator test (scripts/test/validate-copy.test.mjs): none of them may flag any line.
//
// Some lines are prices in prose ("The price 9,200 per sqm"): the intake's price-in-copy rule may
// flag those, so only the FORBIDDEN (contact/brand) rules are asserted against this list.
export const ORDINARY_COPY = [
  'SAR 4,500,000',
  '537 sqm of built-up area',
  'built in 2019',
  'five bedrooms and five parking bays',
  'Jeddah 21589',
  'Phase 2.0',
  '2.5 m ceilings',
  'Area 0125 m²',
  'Buildings 01–14',
  '800 sqm park',
  'The price 9,200 per sqm',
  'Areas from 9200 to 12000 m²',
  'St.Regis',
  'K.S.A',
  '@ the corniche',
  '3 bedrooms.Net area 180 m²',
  'Kids play area 24/7',
  'ضمان ١٠ سنوات على الهيكل الإنشائي',
  'ضمان سنتين على الأعمال الكهربائية والسباكة',
  'على بعد ٥ دقائق من كورنيش جدة',
  '١٥ دقيقة من مطار الملك عبدالعزيز الدولي',
  'قرب طريق الأمير سلطان',
  'المساحات من ١٢٥ إلى ٢٨٠ م²',
  'المباني من ٠١ إلى ١٤',
  'السعر ١٬٢٥٠٬٠٠٠ ريال',
];
