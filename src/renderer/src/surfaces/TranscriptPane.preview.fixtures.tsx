// Fixtures for TranscriptPane.preview.tsx: open and folded on each side of 864px (hidden, beside) and 1264px
// (beside, gutter), and in the stretch below 1032px where the folded column grows to its full 768px.
const widths = [820, 900, 1100, 1300];

export default widths.flatMap((width) => [
  { name: `${width}px, open`, props: { width, folded: false } },
  { name: `${width}px, folded`, props: { width, folded: true } },
]);
