# AI Journal

A personal journal for organizing thoughts and ideas: discussions with Claude,
distilled into notes and questions, arranged on a living mind map.

This is the first thin slice. It contains:

- **`web/`** The web application: mind map, review queue, discussions, drill-down, trail.
- **`functions/`** The journal connector: lets Claude save a discussion to the
  journal and read briefings from it.
- **`firestore.rules`** Keeps the journal private to one account.

Not in this slice yet: conversations with Claude inside the app, and the other
sources (Audible, Flipboard, podcasts, YouTube, browsers).

## Try it without any setup

    cd web
    npm install
    npm run dev

With no Firebase settings, the app runs as a demo journal stored in that
browser only. Choose "Add the starting topics" to begin.

## Check the connector locally

    cd functions
    npm install
    npm run smoke

This runs the connector against an in-memory journal and prints PASS or FAIL
for each rule (who originated a note, what stays proposed, the six-note limit,
what a briefing shows).

## Set up on Firebase

You need a Google account and Node.js 22. Console labels may differ slightly
from the wording below.

1. **Create the project.** In the Firebase console, add a project.
2. **Database.** Build > Firestore Database > Create database (production mode).
3. **Sign-in.** Build > Authentication > Sign-in method > enable Google.
4. **Web app settings.** Project settings > Your apps > add a Web app. Copy the
   four values into a new file `web/.env.local`, following `web/.env.example`.
5. **Billing plan.** Server-side functions need the pay-as-you-go (Blaze) plan.
   At this scale the cost should be close to nothing, but set a budget alert.
6. **Tools.** In a terminal:

       npm install -g firebase-tools
       firebase login
       firebase use --add          # pick the project

7. **Connector key.** Invent a long random secret (for example, run
   `openssl rand -hex 32`) and store it:

       firebase functions:secrets:set CONNECTOR_KEY

   Keep a copy: Claude needs it in step 10.
8. **Build and deploy.**

       (cd functions && npm install)
       (cd web && npm install && npm run build)
       firebase deploy

   The output lists a Hosting URL (the app) and a Function URL for `connector`.
9. **Claim the journal.** Open the Hosting URL, sign in with Google and choose
   "Claim this journal". From then on only that account can read or write it.
   Then choose "Add the starting topics".
10. **Add the connector to Claude.** On the web or desktop app, add a custom
    connector:
    - URL: the Function URL for `connector` from step 8
    - Authentication: no sign-in
    - Request header: `Authorization` with the value `Bearer <your key>`

    If the connector will not connect with the header, leave the headers
    empty and append `?key=<your key>` to the URL instead. Treat that whole
    address as private.

## Using it

In any Claude conversation, with the connector enabled:

- "Save this to my journal." State the date for an older discussion
  ("from March 3rd"); without one it is dated today and marked unconfirmed.
- "Add the new part of this discussion to my journal." For a conversation
  that was saved earlier and has continued; the new messages and notes join
  the existing discussion.
- For a long discussion Claude sends the transcript in parts. If that fails,
  open Discussions in the app, choose "Add a discussion by pasting", paste the
  whole conversation, then tell Claude: "Distill discussion <id> in my journal."
- "Show me my journal map."
- "Pull my briefing on cultural evolution."

Then open the app. Your own notes and questions are already accepted. Claude's
wait under Review, along with suggested links to topics.

## How the rules are enforced

| Rule | Where |
| --- | --- |
| A note's originator never changes | `web/src/journal.ts` (`accept`), `functions/src/mcp.ts` |
| Claude's notes and links stay proposed until accepted | `functions/src/mcp.ts` (`save_thread`) |
| At most six notes per saved discussion | `functions/src/mcp.ts` (`MAX_NOTES`) |
| Editing a note keeps every earlier version | `web/src/journal.ts` (`editNote`) |
| A confirmed suggestion moves to the manual layer | `web/src/journal.ts` (`confirmLink`) |
| A book's reading status places it under Books | `web/src/journal.ts` (`shelve`) |
| Briefings show only accepted items and confirmed links | `functions/src/briefing.ts` |
| Only the owner can read or write | `firestore.rules` |

## Known limits of this slice

- A discussion's transcript is stored inside one database record, which caps
  it at roughly a megabyte of text. Long enough for ordinary discussions.
- The connector reads the whole journal on each call. Fine at personal scale.
- The mind map is readable on a desktop or iPad. On a phone it is small.
- Trails are remembered per browser, not yet saved to the journal.
