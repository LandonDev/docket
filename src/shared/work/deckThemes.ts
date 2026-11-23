import { OFFICE_THEME, TEMPCODE_THEME, type OfficeTheme } from 'work-kit/format/theme'

/**
 * The themes a deck can be given by hand (docs/agents/work-slides.md "Themes"): each is twelve colours and two
 * fonts, written into the deck's own theme part by a `theme` edit. A deck's layouts and master stay its own.
 * Office's two are its real defaults (2013 on, and 2007 to 2010); Greyscale is Office's of that name.
 */
export const DECK_THEMES: readonly OfficeTheme[] = [
  OFFICE_THEME,
  TEMPCODE_THEME,
  {
    name: 'Office 2007\u20132010',
    colours: {
      dk1: '000000', lt1: 'FFFFFF', dk2: '1F497D', lt2: 'EEECE1',
      accent1: '4F81BD', accent2: 'C0504D', accent3: '9BBB59', accent4: '8064A2', accent5: '4BACC6', accent6: 'F79646',
      hlink: '0000FF', folHlink: '800080',
    },
    fonts: { heading: 'Cambria', body: 'Calibri' },
  },
  {
    name: 'Greyscale',
    colours: {
      dk1: '000000', lt1: 'FFFFFF', dk2: '000000', lt2: 'F8F8F8',
      accent1: 'DDDDDD', accent2: 'B2B2B2', accent3: '969696', accent4: '808080', accent5: '5F5F5F', accent6: '4D4D4D',
      hlink: '5F5F5F', folHlink: '919191',
    },
    fonts: { heading: 'Calibri Light', body: 'Calibri' },
  },
]

/** A theme as a `theme` edit takes it. */
export const themeEdit = (theme: OfficeTheme): { op: 'theme'; colors: Record<string, string>; major: string; minor: string } => ({ op: 'theme', colors: { ...theme.colours }, major: theme.fonts.heading, minor: theme.fonts.body })
