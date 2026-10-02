// Preload for subprocess tests: freezes `new Date()` / Date.now() at process.env.FAKE_NOW (ISO string).
const fixed = Date.parse(process.env.FAKE_NOW);
if (Number.isNaN(fixed)) throw new Error('FAKE_NOW must be an ISO date');
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [fixed])); }
  static now() { return fixed; }
}
globalThis.Date = FakeDate;
