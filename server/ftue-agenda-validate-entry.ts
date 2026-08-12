// Build-time guard for the code-owned FTUE onboarding agenda fixture.
//
// The Session agenda runtime contract (item count, 3–5 word titles, ≤600 char
// descriptions) is only enforced when an agenda is instantiated into a live
// Session, and runtime attach fails gracefully by dropping the agenda. A fixture
// that violates the contract therefore surfaces only as broken onboarding on the
// first real signup. script/build.ts bundles and executes this entry so such a
// violation fails the production build instead. It performs no database or
// network work.
import { validateFtueAgendaFixture } from "./ftue-session";

validateFtueAgendaFixture();
console.log("[ftue-agenda] fixture valid");
