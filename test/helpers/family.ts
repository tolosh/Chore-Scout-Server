/** A seeded test family in the FakeBob: Sarah (funded), Mia and Leo linked and active, each with three jars. */
import type { FakeBob } from '../fakes/bob.js'

export const SARAH = 'cust_T_SARAH'
export const MIA = 'cust_T_MIA'
export const LEO = 'cust_T_LEO'
export const OTHER = 'cust_T_OTHER'
export const OTHER_KID = 'cust_T_OTHER_KID'

export function seedFamily(bob: FakeBob, fundingCents = 10_000) {
  bob.addAdult(SARAH).addChild(MIA).addChild(LEO, 'bank_bilgola', 'youth').link(SARAH, MIA).link(SARAH, LEO)
  bob.addAdult(OTHER).addChild(OTHER_KID).link(OTHER, OTHER_KID)
  const funding = bob.openAccount(SARAH, 'funding', fundingCents)
  const otherFunding = bob.openAccount(OTHER, 'funding', fundingCents)
  for (const kid of [MIA, LEO, OTHER_KID]) for (const jar of ['spend', 'save', 'give'] as const) bob.openAccount(kid, jar)
  return { funding, otherFunding }
}
