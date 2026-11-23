# AlmsManager

A desktop app for the alms cases attached to members and churches. It tracks:

- each request as it comes in, and whether it was approved or declined;
- the check to send, or the invoice to write off, every quarter;
- each year's review, to renew a case for the next year or let it end.

Every morning a Power Automate flow emails what's due, and keeps emailing it each day until someone marks it done here.

There is no separate sign-in. AlmsManager uses whoever is signed in to [AB Apps](https://github.com/AB-Kevin/ab-apps), and keeps its data in the AB Apps folder. Members and churches come from [MemberManager](https://github.com/AB-Kevin/MemberManager)'s list. Nothing about alms is written back to MemberManager, so none of it reaches FormTracker or SendNewsletters, which read MemberManager's fields.

## How a case works

1. **New request.** Choose the member or church from MemberManager's list. Say what the request is for, when it came in and who brought it, how it would be paid, and the amount asked for, if known.
2. **Approve or decline.** Approving sets the amount each quarter, whether it's paid by check or by writing off an invoice, and the dates it runs. By default it runs from the day it's approved through December 31. From October on, it runs through the end of the next year.
3. **Quarterly payments.** An approved case has one payment task for each calendar quarter it touches. The task is due on the quarter's first day, or on the start date for the first quarter. **Mark done** records the date and, optionally, the check or invoice number.
4. **Yearly review.** Thirty days before the approval runs out (December 1, for a December 31 end), the case is due for review:
   - **Renew** moves the end date a year on, with a new amount or payment method if they changed, and adds next year's payments and review.
   - **Don't renew** lets it end when the approval runs out. Any payments left in the year are still due.
5. **Close case** ends an approved case early. Its tasks not yet done are dropped.

**Documents:** add a request letter, a bill or anything else to a case with **Add document…**, or by dropping files on the case's window. Each file is copied into the AB Apps folder, so it opens on every computer and stays even if the original is moved or deleted. **Remove** takes it off the case and deletes the copy.

Every change is kept in the case's history, with who made it and when. **Undo** takes back a task marked done by mistake. A renewal can't be undone; change the case's dates with **Edit** instead.

**Who can use it:** everyone the app is given to on AB Apps' **App access** page can add, approve and mark cases. By default that's managers only. Only managers change who gets the reminder email.

## The reminder email

See [docs/power-automate.md](docs/power-automate.md) for setting up the flow, step by step.

- AlmsManager writes `reminders.json` to its folder. It lists every task not yet done, with its due date, and the reminder address from **Settings**.
- The flow runs daily and emails the tasks due today or earlier. It sends nothing when nothing is due.
- Because every future due date is already in the file, the flow works without anyone opening AlmsManager first. Marking a task done takes it off the next email.

## How the data is stored

Everything lives in the `AlmsManager` subfolder of the AB Apps folder:

| File | What it is | Written by |
| --- | --- | --- |
| `cases/<id>.json` | one case: its details, approval, done tasks, documents and history | anyone, one case at a time |
| `files/<id>/` | copies of that case's documents, each written once and never changed | whoever adds it |
| `settings.json` | who gets the reminder email | managers |
| `reminders.json` | what Power Automate reads | any computer with AlmsManager open; rebuilt from the cases |

OneDrive can't merge two computers' changes to one file, so each case has its own file. Every change re-reads the case's file just before writing it. Two people only collide if they change the same case within the minute or so OneDrive takes to sync. If they do, OneDrive keeps both copies, and AlmsManager shows a banner naming the case, so someone can check it and delete the copy named with a computer's name.

## Limits worth knowing

- **Signing in is not security.** Anyone the AB Apps folder is shared with can open the case files in File Explorer. App access on AB Apps decides who sees AlmsManager, not who can read its folder.
- **Reminders depend on OneDrive syncing.** A task marked done on a computer that's offline stays on the email until that computer syncs.
- **Amounts are per quarter**, in dollars. A one-time gift is a case approved for a single quarter: set **Runs through** to the end of the quarter it starts in.

## Development

```
npm install
npm start      # run the app
npm test       # unit tests for the schedule, the case rules, storage and the build settings
npm run dist   # build the Windows installer into dist/
```

`npm start` uses whoever is signed in to AB Apps on this computer. To try it without touching real data, point `AB_APPS_PROFILE` at a folder with its own `identity.json`, whose `dataDir` is a test folder. ab-common's `abapps.js` describes the file.

Launching from a VS Code terminal sets `ELECTRON_RUN_AS_NODE`, which makes Electron start as plain Node. Unset it first.

### Releasing

Pushing a version tag builds the Windows installer on GitHub and publishes it as a release (`.github/workflows/release.yml`). Once your changes are committed:

```
npm version patch       # or minor / major: runs the tests, bumps the version, commits, and tags vX.Y.Z
git push --follow-tags
```

The release appears a few minutes later as `AlmsManager-Setup-X.Y.Z.exe`, with the `latest.yml` that AB Apps and the app's own update check read.
