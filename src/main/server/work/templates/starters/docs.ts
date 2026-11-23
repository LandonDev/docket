import type { Block } from 'work-kit/formats'
import { docBuilder } from './docx'

/**
 * The starter documents as blocks for work-kit's `writeDocx`, by starter key
 * (`<sector>/<slug>`, manifest.ts). Each is a working skeleton: the sections
 * a professional would start from, a line under each that says what goes
 * there, and plainly made-up sample rows. No name of an employer, school,
 * league, game or person: where one belongs, a field (`{{Job}}`, `{{Name}}`,
 * `{{Client}}`) stands in. Tables are sized to the page's 624 pixels.
 */

export interface DocFixture {
  blocks: Block[]
  /** the page's header and footer: one line each (`{PAGE}` is the page's number) */
  header?: string
  footer?: string
}

const PAGE = 'Page {PAGE}'

export const DOCS: Record<string, () => DocFixture> = {
  'any/meeting-notes': () => {
    const d = docBuilder()
    return {
      header: '{{Job}}',
      footer: PAGE,
      blocks: [
        d.h1('{{Meeting}}'),
        d.facts([
          ['Date', '{{Date}}'],
          ['Time and place', 'Start time, end time, room or call link'],
          ['Attendees', 'Person one, Person two, Person three'],
          ['Notes by', '{{Name}}']
        ]),
        d.h2('Agenda'),
        ...d.numbered(['Topic one', 'Topic two', 'Topic three']),
        d.h2('Discussion'),
        d.h3('Topic one'),
        ...d.bullets(['The main points raised, one per line.', 'Questions left open.']),
        d.h3('Topic two'),
        ...d.bullets(['The main points raised, one per line.']),
        d.h3('Topic three'),
        ...d.bullets(['The main points raised, one per line.']),
        d.h2('Decisions'),
        ...d.bullets(['Decision one, and who made it.']),
        d.h2('Action items'),
        d.table(
          [300, 164, 160],
          [
            ['Action', 'Owner', 'Due'],
            ['Action one', 'Person one', 'Date'],
            ['Action two', 'Person two', 'Date'],
            ['', '', '']
          ]
        ),
        d.h2('Next meeting'),
        d.p('Date, time and what it will cover.')
      ]
    }
  },

  'cosmic/release-note': () => {
    const d = docBuilder()
    return {
      header: '{{Job}}',
      footer: PAGE,
      blocks: [
        d.h1('Release {{Version}}'),
        d.facts([
          ['Release date', 'Date of the rollout'],
          ['Prepared', '{{Date}} by {{Name}}'],
          ['Downtime', 'None expected, or the window and its length']
        ]),
        d.h2('Highlights'),
        d.p('Two or three sentences on what this release brings and who it is for.'),
        d.h2('New'),
        ...d.bullets(['**Feature one.** What it does and where to find it.', '**Feature two.** What it does and where to find it.']),
        d.h2('Changed'),
        ...d.bullets(['**Change one.** What was, what is now, and why.', '**Balance or tuning.** The old and new values, side by side.']),
        d.h2('Fixed'),
        ...d.bullets(['Fixed an issue where something happened when it should not have.', 'Fixed an issue where something did not happen when it should have.']),
        d.h2('Known issues'),
        ...d.bullets(['Issue one, who it affects, and the way around it until it is fixed.']),
        d.h2('For staff'),
        d.p('Steps to take before or after the release, commands or settings that changed, and who to ask.'),
        d.h2('Thanks'),
        d.p('The people and reports that helped with this release.')
      ]
    }
  },

  'cosmic/incident-report': () => {
    const d = docBuilder()
    return {
      header: '{{Job}} · Incident report',
      footer: PAGE,
      blocks: [
        d.h1('{{Incident}}'),
        d.facts([
          ['Status and severity', 'Resolved, monitoring, or open · Sev 1, 2 or 3'],
          ['Started and resolved', 'Date and time · date and time'],
          ['Written by', '{{Name}}, {{Date}}']
        ]),
        d.h2('Summary'),
        d.p('In three sentences: what broke, who it hit, and how it was put right.'),
        d.h2('Impact'),
        ...d.bullets(['**Who was affected:** how many players or staff, and where.', '**What they saw:** errors, lost progress, downtime.', '**How long:** from the first report to the fix.']),
        d.h2('Timeline'),
        d.table(
          [120, 504],
          [
            ['Time', 'What happened'],
            ['00:00', 'First alert or report, and who picked it up.'],
            ['00:00', 'Cause found.'],
            ['00:00', 'Fix deployed and confirmed.']
          ]
        ),
        d.h2('Cause and fix'),
        d.p('**Cause:** what went wrong, and why it was able to. Facts, not blame.'),
        d.p('**Fix:** what was done to stop it, and anything restored or given back.'),
        d.h2('Follow-up actions'),
        d.table(
          [300, 124, 100, 100],
          [
            ['Action', 'Owner', 'Due', 'Status'],
            ['Action one', 'Person one', 'Date', 'Open'],
            ['Action two', 'Person two', 'Date', 'Open']
          ]
        ),
        d.h2('Lessons learned'),
        ...d.bullets(['**What went well:**', '**What went poorly:**', '**Where we were lucky:**'])
      ]
    }
  },

  'hypixel/video-brief': () => {
    const d = docBuilder()
    return {
      header: '{{Job}} · Video brief',
      footer: PAGE,
      blocks: [
        d.h1('{{Video}}'),
        d.facts([
          ['Producer', '{{Name}}'],
          ['Brief date', '{{Date}}'],
          ['Length', 'Target running time'],
          ['Where it runs', 'Channel, platform, and format (16:9, 9:16)']
        ]),
        d.h2('Goal'),
        d.p('One sentence: what this video must do, and how we will know it worked.'),
        d.h2('Audience'),
        d.p('Who it is for, what they already know, and what they care about.'),
        d.h2('Key message'),
        d.p('The one thing a viewer should remember.'),
        d.h2('Content'),
        ...d.bullets(['Hook: the first five seconds.', 'Main beats, in order.', 'Call to action at the end.']),
        d.h2('Look, sound and references'),
        ...d.bullets(['Tone and pace.', 'Music and sound.', 'Reference videos, with what to take from each.']),
        d.h2('Deliverables'),
        d.table(
          [260, 140, 224],
          [
            ['Deliverable', 'Format', 'Notes'],
            ['Main cut', '16:9, 4K', ''],
            ['Short cut', '9:16, 1080p', ''],
            ['Thumbnail', '1280 × 720', '']
          ]
        ),
        d.h2('Schedule'),
        d.table(
          [260, 140, 224],
          [
            ['Milestone', 'Date', 'Owner'],
            ['Script locked', 'Date', 'Person one'],
            ['Shoot or capture', 'Date', 'Person two'],
            ['First cut for review', 'Date', 'Person two'],
            ['Final cut', 'Date', 'Person two'],
            ['Publish', 'Date', '{{Name}}']
          ]
        ),
        d.h2('Approvals'),
        d.p('Who signs off on the script and on the final cut.')
      ]
    }
  },

  'hypixel/script': () => {
    const d = docBuilder()
    return {
      header: '{{Job}} · Script',
      footer: PAGE,
      blocks: [
        d.h1('{{Video}}'),
        d.facts([
          ['Writer', '{{Name}}'],
          ['Draft', 'One, {{Date}}'],
          ['Running time', 'Target length']
        ]),
        d.h2('Logline'),
        d.p('The video in one sentence.'),
        d.h2('Script'),
        d.table(
          [36, 248, 268, 72],
          [
            ['#', 'Picture', 'Sound and voice', 'Time'],
            ['1', '**Cold open.** What we see in the first seconds.', '**VO:** The hook, word for word.', '0:00'],
            ['2', '**Title card.**', 'Music sting.', '0:10'],
            ['3', '**Part one.** Shots and on-screen text.', '**VO:** What is said over it.', '0:15'],
            ['4', '**Part two.** Shots and on-screen text.', '**VO:** What is said over it.', '1:00'],
            ['5', '**Close.** End screen.', '**VO:** The call to action.', '2:00']
          ]
        ),
        d.h2('On-screen text'),
        ...d.bullets(['Each caption or title, with where it appears.']),
        d.h2('Music and sound'),
        ...d.bullets(['Tracks, with their licenses.', 'Sound effects to find or record.']),
        d.h2('Notes for the edit'),
        d.p('Pacing, cuts to avoid, anything the editor should know.')
      ]
    }
  },

  'purdue/memo': () => {
    const d = docBuilder()
    return {
      header: '{{Job}}',
      footer: PAGE,
      blocks: [
        d.h1('Memo'),
        d.facts(
          [
            ['To', '{{To}}'],
            ['From', '{{Name}}'],
            ['Date', '{{Date}}'],
            ['Subject', '{{Subject}}']
          ],
          [100, 524]
        ),
        d.h2('Purpose'),
        d.p('One or two sentences: why you are writing and what you need from the reader.'),
        d.h2('Background'),
        d.p('The facts the reader needs, briefly, with numbers where they help.'),
        d.h2('Recommendation'),
        d.p('What you propose, what it costs, and what happens if nothing changes.'),
        d.h2('Next steps'),
        ...d.numbered(['Step one, who takes it, and by when.', 'Step two, who takes it, and by when.'])
      ]
    }
  },

  'purdue/event-run-of-show': () => {
    const d = docBuilder()
    return {
      header: '{{Job}} · Run of show',
      footer: PAGE,
      blocks: [
        d.h1('{{Event}}'),
        d.facts([
          ['When', 'Event date · doors 00:00 · start 00:00 · end 00:00'],
          ['Venue', 'Room or space, and its address']
        ]),
        d.h2('Contacts'),
        d.table(
          [200, 224, 200],
          [
            ['Role', 'Name', 'Phone'],
            ['Event lead', '{{Name}}', ''],
            ['Production', 'Person one', ''],
            ['Venue', 'Person two', ''],
            ['Host', 'Person three', ''],
            ['Safety and first aid', 'Person four', '']
          ]
        ),
        d.h2('If something goes wrong'),
        ...d.bullets(['**Someone is hurt:** the first-aid point and the number to call.', '**Power or network fails:** who calls whom, and what we do meanwhile.', '**We run late:** which segment gets shorter.']),
        d.h2('Run of show'),
        d.table(
          [64, 152, 248, 160],
          [
            ['Time', 'Segment', 'Details and cues', 'Owner'],
            ['00:00', 'Crew call', 'Set up, power, and network checks.', 'Production'],
            ['00:00', 'Doors open', 'Check-in desk staffed; music on.', 'Venue'],
            ['00:00', 'Welcome', 'Host on stage; slides on screen one.', 'Host'],
            ['00:00', 'Segment one', 'What happens, and the cue to start it.', 'Event lead'],
            ['00:00', 'Break', 'Fifteen minutes; reset the stage.', 'Production'],
            ['00:00', 'Segment two', 'What happens, and the cue to start it.', 'Event lead'],
            ['00:00', 'Close', 'Thanks, next event, photos.', 'Host'],
            ['00:00', 'Load out', 'Strike, pack and return the room.', 'Production']
          ]
        ),
        d.h2('Equipment'),
        ...d.checks(['Screens, cables and adapters', 'Microphones and spare batteries', 'Network, power strips, signs and check-in sheets'])
      ]
    }
  },

  'ref/game-report': () => {
    const d = docBuilder()
    return {
      header: 'Game report',
      footer: PAGE,
      blocks: [
        d.h1('{{Home}} vs {{Away}}'),
        d.facts([
          ['Home', '{{Home}}'],
          ['Away', '{{Away}}'],
          ['Site', '{{Site}}'],
          ['Game date', 'Date played'],
          ['Sport and level', 'Varsity, junior varsity, or other'],
          ['Final score', 'Home 0, Away 0']
        ]),
        d.h2('Crew'),
        d.table(
          [200, 424],
          [
            ['Position', 'Official'],
            ['Referee', '{{Name}}'],
            ['Second official', 'Official two'],
            ['Third official', 'Official three']
          ]
        ),
        d.h2('Summary'),
        d.p('How the game went, in a few sentences: pace, sporting conduct, anything the assignor should know.'),
        d.h2('Unusual situations'),
        d.table(
          [120, 272, 232],
          [
            ['When', 'What happened', 'Ruling'],
            ['Period, time', 'The play or situation, plainly.', 'The call made and the rule behind it.'],
            ['', '', '']
          ]
        ),
        d.h2('Ejections, injuries and conduct'),
        d.p('Anyone ejected, any injury that stopped play, any unsporting conduct, with names and numbers. Write “None” if there was nothing.'),
        d.h2('Follow-up'),
        ...d.bullets(['Reports still to file, and with whom.', 'Anything to raise with the schools or the assignor.']),
        d.p('Submitted by {{Name}} on {{Date}}.')
      ]
    }
  },

  'ref/incident-report': () => {
    const d = docBuilder()
    return {
      header: 'Incident report',
      footer: PAGE,
      blocks: [
        d.h1('Incident report'),
        d.facts([
          ['Game', '{{Home}} vs {{Away}}'],
          ['Game date', 'Date'],
          ['Sport and level', 'Varsity, junior varsity, or other'],
          ['When', 'Period and time on the clock'],
          ['Reported by', '{{Name}}'],
          ['Report date', '{{Date}}']
        ]),
        d.h2('People involved'),
        d.table(
          [200, 164, 160, 100],
          [
            ['Name', 'Role', 'Team', 'Number'],
            ['Person one', 'Player, coach, or spectator', '{{Home}}', ''],
            ['Person two', 'Player, coach, or spectator', '{{Away}}', '']
          ]
        ),
        d.h2('What happened'),
        d.p('In order and in plain words: what you saw and heard, where you were, and when. Quote words exactly where it matters.'),
        d.h2('Action taken'),
        d.p('The penalty, ejection or stoppage, and how play went on.'),
        d.h2('Witnesses'),
        d.table(
          [224, 200, 200],
          [
            ['Name', 'Role', 'Contact'],
            ['Official two', 'Official', ''],
            ['', '', '']
          ]
        ),
        d.h2('Statement'),
        d.p('I confirm this report is true and complete to the best of my knowledge.'),
        d.p('Signed: {{Name}}          Date: {{Date}}')
      ]
    }
  },

  'unify/proposal': () => {
    const d = docBuilder()
    return {
      header: '{{Job}} · Proposal',
      footer: PAGE,
      blocks: [
        d.h1('Proposal for {{Client}}'),
        d.facts([
          ['Project', '{{Project}}'],
          ['Prepared by', '{{Name}}, {{Job}}'],
          ['Date', '{{Date}}'],
          ['Valid until', 'Date']
        ]),
        d.h2('Summary'),
        d.p('What {{Client}} needs, what we will do about it, and what it will cost, in one paragraph.'),
        d.h2('What we heard'),
        ...d.bullets(['The problem as the client put it.', 'What it is costing them now.', 'What success looks like for them.']),
        d.h2('Our approach'),
        d.p('How we will solve it, and why this way.'),
        d.h2('Scope'),
        ...d.bullets(['**Included:** each piece of work, plainly.', '**Not included:** what we will not do, so no one is surprised.']),
        d.h2('Timeline'),
        d.table(
          [200, 324, 100],
          [
            ['Phase', 'What happens', 'Weeks'],
            ['Discovery', 'Interviews, audit of what exists, a plan.', '1–2'],
            ['Build', 'The work itself, with a review each week.', '4–6'],
            ['Launch', 'Go live, train the team, hand over.', '1']
          ]
        ),
        d.h2('Investment'),
        d.p('Half on signing and half on launch, each invoice due within 30 days.'),
        d.table(
          [444, 180],
          [
            ['Item', 'Amount'],
            ['Discovery', '$0.00'],
            ['Build', '$0.00'],
            ['Launch and training', '$0.00'],
            ['**Total**', '**$0.00**']
          ]
        ),
        d.h2('Why {{Job}}'),
        d.p('Relevant work, the team, and what makes us the right fit.'),
        d.h2('Next steps'),
        ...d.numbered(['Reply with questions or changes.', 'Sign below to accept.', 'We schedule the kickoff.']),
        d.h2('Acceptance'),
        d.table(
          [312, 312],
          [
            ['For {{Client}}', 'For {{Job}}'],
            ['Name:', 'Name: {{Name}}'],
            ['Signature:', 'Signature:'],
            ['Date:', 'Date:']
          ]
        )
      ]
    }
  },

  'unify/statement-of-work': () => {
    const d = docBuilder()
    return {
      header: '{{Job}} · Statement of work',
      footer: PAGE,
      blocks: [
        d.h1('Statement of work'),
        d.facts([
          ['Client', '{{Client}}'],
          ['Project', '{{Project}}'],
          ['Provider', '{{Job}}'],
          ['Prepared by', '{{Name}}'],
          ['Date', '{{Date}}'],
          ['Term', 'Start date to end date']
        ]),
        d.h2('1. Background'),
        d.p('Why this work is needed, in a short paragraph.'),
        d.h2('2. Objectives'),
        ...d.bullets(['Objective one, with how it will be measured.', 'Objective two, with how it will be measured.']),
        d.h2('3. Scope of work'),
        d.h3('In scope'),
        ...d.bullets(['Task one.', 'Task two.']),
        d.h3('Out of scope'),
        ...d.bullets(['Anything the client might assume is included but is not.']),
        d.h2('4. Deliverables'),
        d.table(
          [40, 180, 304, 100],
          [
            ['#', 'Deliverable', 'Description', 'Due'],
            ['1', 'Deliverable one', 'What it is and the form it comes in.', 'Date'],
            ['2', 'Deliverable two', 'What it is and the form it comes in.', 'Date']
          ]
        ),
        d.h2('5. Roles'),
        ...d.bullets(['**{{Job}}:** the work above, weekly updates, a named lead ({{Name}}).', '**{{Client}}:** a named contact, access and feedback within three working days.']),
        d.h2('6. Assumptions'),
        ...d.bullets(['Each assumption the price and timeline depend on.']),
        d.h2('7. Acceptance'),
        d.p('How each deliverable is reviewed and accepted, and how long the client has to do it.'),
        d.h2('8. Fees and payment'),
        d.table(
          [324, 150, 150],
          [
            ['Milestone', 'Amount', 'Invoiced'],
            ['On signing', '$0.00', 'Date'],
            ['Deliverable one accepted', '$0.00', 'Date'],
            ['Deliverable two accepted', '$0.00', 'Date']
          ]
        ),
        d.p('Invoices are due within 30 days. Expenses are billed at cost only when agreed in advance.'),
        d.h2('9. Changes'),
        d.p('A change to scope, timeline or fees is agreed in writing by both parties before work on it starts.'),
        d.h2('10. Signatures'),
        d.table(
          [312, 312],
          [
            ['For {{Client}}', 'For {{Job}}'],
            ['Name:', 'Name: {{Name}}'],
            ['Signature:', 'Signature:'],
            ['Date:', 'Date:']
          ]
        )
      ]
    }
  },

  'life/trip-plan': () => {
    const d = docBuilder()
    return {
      header: 'Trip plan',
      footer: PAGE,
      blocks: [
        d.h1('{{Trip}}'),
        d.facts([
          ['Dates', 'Leave date to return date'],
          ['Travelers', '{{Name}}, Person two'],
          ['Budget', '$0.00'],
          ['Planned', '{{Date}}']
        ]),
        d.h2('Getting there and back'),
        d.table(
          [120, 100, 136, 136, 132],
          [
            ['Leg', 'Date', 'Departs', 'Arrives', 'Booking'],
            ['Outbound', 'Date', 'Place, 00:00', 'Place, 00:00', 'Reference'],
            ['Return', 'Date', 'Place, 00:00', 'Place, 00:00', 'Reference']
          ]
        ),
        d.h2('Where we are staying'),
        d.table(
          [140, 200, 152, 132],
          [
            ['Nights', 'Place', 'Address', 'Booking'],
            ['Date to date', 'Place one', '', 'Reference']
          ]
        ),
        d.h2('Day by day'),
        d.h3('Day one'),
        ...d.bullets(['Morning:', 'Afternoon:', 'Evening:']),
        d.h3('Day two'),
        ...d.bullets(['Morning:', 'Afternoon:', 'Evening:']),
        // The itinerary keeps page one; the lists to work through before going stand together on page two.
        d.newPage(),
        d.h2('Before we leave'),
        ...d.checks(['Passports or IDs checked', 'Bookings printed or saved offline', 'Bank told of travel', 'Home: mail, plants, keys']),
        d.h2('Packing'),
        ...d.checks(['Clothes for the weather', 'Chargers and adapters', 'Medicines', 'Documents']),
        d.h2('Contacts'),
        ...d.bullets(['Emergency contact:', 'The stay’s phone:'])
      ]
    }
  },

  'life/checklist': () => {
    const d = docBuilder()
    return {
      footer: PAGE,
      blocks: [
        d.h1('Checklist'),
        d.p('Started {{Date}}.'),
        d.h2('Must do'),
        ...d.checks(['Item one', 'Item two', 'Item three']),
        d.h2('Should do'),
        ...d.checks(['Item four', 'Item five']),
        d.h2('Waiting on'),
        ...d.checks(['Item six, and who it waits on']),
        d.h2('Notes'),
        d.p('Anything worth keeping beside the list.')
      ]
    }
  }
}
