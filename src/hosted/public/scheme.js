// Runs before the guest page's stylesheet, whose default theme is dark: a
// viewer whose system is light starts light. GuestApp follows a later change.
if (!window.matchMedia("(prefers-color-scheme: dark)").matches) {
  document.documentElement.classList.add("theme-light");
}
