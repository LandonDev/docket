import type { NewDeck } from '@shared/contract-work-slides'

/**
 * The starter decks as inputs to the slides pillar's own `slides_new` tool,
 * by starter key (manifest.ts). The deck wears the theme `slides_new`
 * writes. Fields go in titles, subtitles, bullets and tables, never in
 * notes: the scan reads slides, not notes. Sample rows are plainly made up.
 * `slides_new` gives a table's columns equal widths, so no table here has a
 * narrow column such as a row number.
 */

export const DECKS: Record<string, NewDeck> = {
  'cosmic/update-briefing': {
    title: 'Update briefing',
    slides: [
      { layout: 'title', title: '{{Update}}', subtitle: '{{Job}} · {{Date}}' },
      { layout: 'bullets', title: 'What’s in it', bullets: ['Headline feature, in one line', 'Second feature, in one line', 'Balance and quality changes', 'Fixes players asked for'] },
      {
        layout: 'table',
        title: 'Timeline',
        table: [
          ['Milestone', 'Date', 'Owner'],
          ['Content locked', 'Date', 'Person one'],
          ['Testing on staging', 'Date', 'Person two'],
          ['Release', 'Date', '{{Name}}'],
          ['Review', 'Date', 'Person one']
        ]
      },
      {
        layout: 'table',
        title: 'Risks',
        table: [
          ['Risk', 'Likelihood', 'What we do about it'],
          ['Risk one', 'Low', 'Mitigation'],
          ['Risk two', 'Medium', 'Mitigation']
        ]
      },
      { layout: 'bullets', title: 'What we need', bullets: ['A decision on one open question', 'Help from another team, and by when', 'Sign-off on the release date'] },
      { layout: 'section', title: 'Questions', subtitle: '{{Name}}' }
    ]
  },

  'hypixel/review-deck': {
    title: 'Review deck',
    slides: [
      { layout: 'title', title: '{{Video}}', subtitle: 'Review · {{Name}} · {{Date}}' },
      { layout: 'bullets', title: 'Watch', bullets: ['The cut (first, second, or final): its link here', 'Password: add it here', 'Running time: 0:00, against a target of 0:00'] },
      {
        layout: 'table',
        title: 'Notes from the last review',
        table: [
          ['At', 'Note', 'Done'],
          ['0:00', 'Note one: what to change, and why', 'Yes'],
          ['0:00', 'Note two: what to change, and why', 'No'],
          ['0:00', 'Note three: what to change, and why', 'No']
        ]
      },
      { layout: 'bullets', title: 'What we want feedback on', bullets: ['The hook in the first five seconds', 'Pacing through the middle', 'The thumbnail and title', 'Decisions needed: each one, and who makes it'] },
      {
        layout: 'table',
        title: 'Next steps',
        table: [
          ['Step', 'Owner', 'Date'],
          ['Make the changes', 'Person one', 'Date'],
          ['Final review', '{{Name}}', 'Date'],
          ['Publish', 'Person two', 'Date']
        ]
      }
    ]
  },

  'purdue/program-update': {
    title: 'Program update',
    slides: [
      { layout: 'title', title: 'Program update: {{Term}}', subtitle: '{{Job}} · {{Name}} · {{Date}}' },
      { layout: 'bullets', title: 'Highlights', bullets: ['Highlight one, with its number', 'Highlight two, with its number', 'Highlight three, with its number'] },
      {
        layout: 'chart',
        title: 'Participation: people each month',
        chart: { type: 'bar', categories: ['Month one', 'Month two', 'Month three', 'Month four'], series: [{ name: 'People taking part', values: [40, 55, 62, 70] }] }
      },
      {
        layout: 'table',
        title: 'Goals so far',
        table: [
          ['Goal', 'Target', 'Result', 'Status'],
          ['Goal one', '100', '104', 'Done'],
          ['Goal two', '50', '38', 'On track'],
          ['Goal three', '20', '6', 'Behind']
        ]
      },
      { layout: 'bullets', title: 'Challenges', bullets: ['Challenge one, and what we are doing about it', 'Challenge two, and what we are doing about it'] },
      { layout: 'bullets', title: 'Next term', bullets: ['Priority one', 'Priority two', 'What we need: budget, space, or staff'] }
    ]
  },

  'unify/pitch-deck': {
    title: 'Pitch deck',
    slides: [
      { layout: 'title', title: 'A proposal for {{Client}}', subtitle: '{{Job}} · {{Date}}' },
      { layout: 'bullets', title: 'What we heard', bullets: ['The problem, in their words', 'What it costs them today', 'What success looks like'] },
      { layout: 'bullets', title: 'What we will build', bullets: ['The solution in one line', 'Part one, and what it changes', 'Part two, and what it changes'] },
      {
        layout: 'table',
        title: 'How we work',
        table: [
          ['Phase', 'Weeks', 'Outcome'],
          ['Discovery', '1–2', 'A plan both sides agree on'],
          ['Build', '4–6', 'Working software, reviewed each week'],
          ['Launch', '1', 'Live, with the team trained']
        ]
      },
      {
        layout: 'table',
        title: 'Investment',
        table: [
          ['Item', 'Amount'],
          ['Discovery', '$0'],
          ['Build', '$0'],
          ['Launch and training', '$0'],
          ['Total', '$0']
        ]
      },
      { layout: 'bullets', title: 'Why {{Job}}', bullets: ['Relevant work', 'The team', 'How we stay in touch'] },
      { layout: 'bullets', title: 'Next steps', bullets: ['Reply with questions or changes', 'Sign the proposal to accept', 'We schedule the kickoff', 'Talk to {{Name}}, {{Job}}'] }
    ]
  }
}
