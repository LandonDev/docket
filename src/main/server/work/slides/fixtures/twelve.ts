import type { NewSlide } from '@shared/contract-work-slides'

/** Twelve slides of every layout a new deck has, with a table and a chart. */
export const TWELVE: NewSlide[] = [
  { layout: 'title', title: 'Spring showcase', subtitle: 'Run of show' },
  { layout: 'section', title: 'Before the doors' },
  ...Array.from({ length: 7 }, (_, i): NewSlide => ({ layout: 'bullets', title: `Point ${i + 1}`, bullets: ['First', { text: 'Under it', level: 1 }, 'Second'], notes: `Say ${i + 1}` })),
  { layout: 'table', title: 'Budget', table: [['Item', 'Cost'], ['Stage', '$4,000'], ['Sound', '$2,500']] },
  { layout: 'chart', title: 'Viewers', chart: { type: 'bar', categories: ['Mon', 'Tue', 'Wed'], series: [{ name: 'Stream', values: [1200, 3400, 6200] }] } },
  { layout: 'title', title: 'Thank you' }
]
