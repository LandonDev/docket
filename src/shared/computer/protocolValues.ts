/**
 * The computer protocol's plain values (docs/computer-protocol.md): what the window's step words read
 * (words.ts, observation.ts, in the first paint) without the schemas. protocol.ts re-exports them and builds its
 * zod over them.
 */

/** The first 17 are Anthropic's `computer_toolset_20260801` member names; the last five are ours. */
export const COMPUTER_ACTION_NAMES = [
  'screenshot',
  'zoom',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_click_drag',
  'mouse_move',
  'left_mouse_down',
  'left_mouse_up',
  'cursor_position',
  'scroll',
  'type',
  'key',
  'hold_key',
  'wait',
  'set_value',
  'perform',
  'select_text',
  'paste',
  'save_as'
] as const
export type ComputerActionNameValue = (typeof COMPUTER_ACTION_NAMES)[number]

/** Actions that send no input: a batch made only of these needs no input gate. */
export const NO_INPUT_ACTION_NAMES: readonly ComputerActionNameValue[] = ['screenshot', 'zoom', 'cursor_position', 'wait']

/** Observation text (§4.1, §4.5). */
export const OBSERVATION_TEXT = {
  indentSpaces: 2,
  maxDepth: 10,
  /** Unicode scalars of a name before `…` */
  nameMaxChars: 100,
  /** Unicode scalars of a value before `…(+<n> chars)` */
  valueMaxChars: 160,
  /** a run of this many unnamed, stateless siblings of one role folds into a range line */
  rangeFoldRun: 6,
  /** thin: fewer elements with a role-default action than this… */
  thinActionable: 3,
  /** …and fewer bytes of names and values than this */
  thinTextBytes: 200
} as const
