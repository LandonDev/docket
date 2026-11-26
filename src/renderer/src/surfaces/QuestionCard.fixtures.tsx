// bun run ui:preview src/renderer/src/surfaces/QuestionCard.tsx#QuestionCard
// Static capture shows the pending card and answer lines. The refusal keeps the choice. Keyboard and submission are covered by the DOM test.
import { waitForPreview } from "../lib/previewHost.preview";
import type { QuestionMeta } from "../lib/session";

const question: QuestionMeta = {
  sessionId: "preview-question",
  requestId: "layout",
  questions: [
    { header: "Navigation", question: "Where should the new tab open?", options: [
      { label: "Beside the current tab", description: "Keep the current view within reach" },
      { label: "At the end", description: "Keep the tabs in the order they opened" },
    ] },
    { header: "Focus", question: "Should it take focus?", options: [{ label: "Yes" }, { label: "No" }] },
  ],
};

export default [
  { name: "Waiting for an answer", props: { question, onAnswer: "fn" } },
  { name: "Answered", props: { question: { ...question, answers: [["Beside the current tab"], ["Yes"]] } } },
  {
    name: "Refused answer reopened with its choice",
    props: {
      question: { ...question, requestId: "refused", questions: [question.questions[0]] },
      onAnswer: () => Promise.reject(new Error("The host did not take the answer")),
    },
    prepare: async (root: HTMLElement) => {
      const option = [...root.querySelectorAll<HTMLElement>('[data-slot="question-option"]')].find((node) => node.textContent?.includes("At the end"));
      if (!option) throw new Error("Missing question choice");
      option.click();
      const submit = await waitForPreview(() => [...root.querySelectorAll("button")].find((button) => button.textContent?.includes("Continue") && !button.disabled));
      submit.click();
    },
  },
  { name: "Dismissed", props: { question: { ...question, answers: null } } },
];
