import { redact } from '../../work/lifeos/transport'

/**
 * Words for why a one-time LifeOS sign-in code did not work: LifeOS's
 * refusal codes (`auth:enrollRedeem`) and the LifeOS desktop's result-file
 * errors, for a setup step's row. Unknown words pass through redacted.
 */
const WORDS: Record<string, string> = {
  'enroll-unknown': 'LifeOS does not know this sign-in code',
  'enroll-used': 'This sign-in code was used already',
  'enroll-expired': 'This sign-in code has expired; make a new link on the Mac',
  'enroll-cancelled': 'This sign-in was withdrawn on the Mac',
  'enroll-wrong-owner': 'This sign-in code belongs to another LifeOS account',
  'wrong owner': 'This sign-in code belongs to another LifeOS account',
  'rate-limited': 'Too many sign-in tries; wait a minute and try again',
  'wrong backend': 'This LifeOS talks to another LifeOS address',
  'attempt mismatch': 'LifeOS read a sign-in meant for another try',
  unreadable: 'LifeOS could not read the sign-in',
  network: 'LifeOS could not reach its backend',
  'bad-response': 'LifeOS got an answer it did not understand'
}

export const enrollWords = (code: string): string => WORDS[code] ?? (/^http-\d+$/.test(code) ? `LifeOS's backend answered ${code.slice(5)}` : redact(code).slice(0, 240))
