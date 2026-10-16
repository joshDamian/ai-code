# auth

## When to use
Sign in, sign up, reset password, verify email, accept an invite - the screens a person meets before the app. This is the one place a centred, single card is right.

## The layout
- **Desktop (1280):** the product name or mark top-left of the page (not floating above the card), and a single column, 400px wide, centred horizontally and placed in the upper third - not dead centre of a tall viewport. Plain `color.bg` page, or a split: the form column on the left half and one quiet brand panel on `color.surface` on the right.
- **The column, top to bottom:** a heading that says what happens here ("Sign in to Bench", 24px semibold), one muted line if needed, then the providers (SSO / "Continue with Google") as full-width secondary buttons, a divider with "or", the email and password fields (`form` rules: labels above), and the **primary button full width** ("Sign in"). "Forgot password?" sits as a link right-aligned on the password label's row, not below the button.
- **Below the column:** the switch to the other flow ("New here? Create an account") as one centred line, 24px under the button.
- **Sign up** asks only what is needed to create the account - often email alone, or email and password. Name, company and role come later, asked in context or in a short `wizard` after the first sign-in.
- **Phone (390):** the same column at full width minus 16px each side, starting 48px from the top; the primary button stays in the flow (not sticky) because the keyboard is up.

## States
- **Submitting:** the button shows a spinner and "Signing in...", fields stay.
- **Wrong credentials:** one message above the button, in `color.danger`, that does not say which field was wrong ("Email or password is incorrect"). Password is kept, focus to password.
- **Rate-limited / locked:** the message says when they can try again.
- **Check your email** (magic link, reset, verify): the column becomes a heading, the address it was sent to in `color.text`, a muted line to check spam, and a "Resend" link that counts down - no form.
- **Expired link:** say it expired and offer to send a new one in one click.

## Spacing & rhythm
- Heading to first control 32px; between provider buttons 8px; the "or" divider 24px above and below; field to field 16px; last field to button 24px.
- Buttons and inputs 44-48px tall here - it is a touch-first, one-time screen.

## Tokens
- `color.bg` (page), `color.surface` (brand panel or the card, if any), `color.text`, `color.text-muted`, `color.border` (inputs, the "or" divider), `color.primary` / `color.on-primary` (the one button), `color.danger`.
- `font.size.*`: 24 heading, 14 labels, 16 inputs.
- `space.*`: 8, 16, 24, 32, 48. `radius.*`: small for inputs and buttons, medium for a card if you use one. `shadow.*`: at most the smallest one on the card in light; none in dark.

## What to avoid
- A stock-photo or gradient background behind a floating glassy card.
- Sign-in and sign-up as tabs on one card, so the person is never sure which they are on.
- Two equal buttons ("Sign in" and "Sign up") side by side.
- A sign-up form that asks for ten fields before the person has seen the product.
- "Invalid input" errors, or errors that reveal whether an email has an account.
- The app shell (navigation, sidebar) visible around a sign-in form.

## Why
Auth is a doorway: one job, done once, by someone who wants to be past it. A single narrow column with one obvious button is the fastest way through, and putting it high on the page keeps the button above the fold on short laptop screens. Asking for less at sign-up gets more people in; the rest is better asked once they know why.
