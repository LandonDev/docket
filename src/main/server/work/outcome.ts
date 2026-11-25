/**
 * The start of an answer whose outcome the host cannot say: LifeOS may have taken the write and its reply was lost on
 * the host's own link to it (a mail's Send or Send Now, a reply's Try Again). The phone keeps such a press Checking
 * and reads it back (PressLedger.reached, `unknownPrefix`), never "not sent".
 */
export const OUTCOME_UNKNOWN = 'outcome unknown'
