# The daily reminder email (Power Automate)

AlmsManager has no server, so it doesn't send email itself. A Power Automate flow does. Every morning it reads AlmsManager's `reminders.json` from the AB Apps folder and emails the tasks that are due: a check to send, an invoice to write off, or a yearly review. A task stays on the email every day until someone marks it done in AlmsManager. When nothing is due, the flow sends nothing.

You set the flow up once. Who gets the email is set in AlmsManager, on **Settings › Reminder email**, so changing it later needs no change to the flow.

## What the flow reads

`<AB Apps folder>\AlmsManager\reminders.json`. AlmsManager's **Settings** page shows the full path and has **Copy file path**.

```json
{
  "version": 1,
  "app": "AlmsManager",
  "generatedAt": "2027-01-20T14:03:11.000Z",
  "basis": "2027-01-20T14:03:10.512Z",
  "sendTo": "office@example.org; kim@example.org",
  "tasks": [
    {
      "due": "2027-04-01",
      "dueText": "4/1/2027",
      "task": "Send the Q2 2027 check",
      "for": "Ann Miller (Member 1234)",
      "amount": "$300.00",
      "line": "4/1/2027 · Send the Q2 2027 check · Ann Miller (Member 1234) · $300.00"
    }
  ]
}
```

- **`tasks`** lists every task not yet done, with its due date, including ones not due for months. The flow doesn't need anyone to open AlmsManager before a task comes due. It only compares `due` with today.
- A task leaves the list as soon as someone marks it done, so it's gone from the next morning's email.
- **`sendTo`** is the address or addresses from AlmsManager's Settings, separated by semicolons as Outlook takes them.
- Any computer with AlmsManager open rewrites the file when something changes. It doesn't rewrite it while a case file is still syncing, or when its copy of the cases is older than the one the file was built from.

## Building the flow

Sign in to [Power Automate](https://make.powerautomate.com) with an account that can open the AB Apps folder. The flow runs as that account and sends the email from its mailbox.

1. **Create › Scheduled cloud flow.** Name it `AlmsManager reminders`. Set it to repeat every **1 day** at, say, **7:00 AM**. Under the trigger's advanced options, set **Time zone** to your own, such as **(UTC-05:00) Eastern Time (US & Canada)**.

2. Add a **Scope** action and rename it `Try`. Steps 3 to 7 go inside it, so step 8 can tell you if any of them fails.

3. **Get file content using path.** Which connector to use depends on where the AB Apps folder lives:
   - **In a SharePoint library:** use **SharePoint › Get file content using path**. Pick the site, and browse to `AB Apps/AlmsManager/reminders.json`.
   - **In the flow account's own OneDrive:** use **OneDrive for Business › Get file content using path**, with the path `/AB Apps/AlmsManager/reminders.json`.
   - **In someone else's OneDrive, shared with the flow account:** use **SharePoint › Get file content using path**. For **Site Address**, choose **Enter custom value** and enter their OneDrive's address, such as `https://yourorg-my.sharepoint.com/personal/mary_yourorg_org`. Then browse to `Documents/AB Apps/AlmsManager/reminders.json`. The OneDrive connector can't see a shared folder, even one added as a shortcut.

4. **Compose.** Rename it `Reminders`. For **Inputs**, enter this expression:

   ```
   json(base64ToString(body('Get_file_content_using_path')?['$content']))
   ```

   If a test run fails here because `$content` is null, the connector has already returned the file as text. Use `json(string(body('Get_file_content_using_path')))` instead.

5. **Parse JSON.** For **Content**, choose the `Reminders` output. For **Schema**, paste this:

   ```json
   {
     "type": "object",
     "properties": {
       "version": { "type": "integer" },
       "generatedAt": { "type": "string" },
       "sendTo": { "type": "string" },
       "tasks": {
         "type": "array",
         "items": {
           "type": "object",
           "properties": {
             "due": { "type": "string" },
             "dueText": { "type": "string" },
             "task": { "type": "string" },
             "for": { "type": "string" },
             "amount": { "type": "string" },
             "line": { "type": "string" }
           }
         }
       }
     }
   }
   ```

6. **Filter array.** Rename it `Due`. For **From**, choose `tasks` from Parse JSON. Choose **Edit in advanced mode**, and enter the following, with your time zone in place of Eastern:

   ```
   @lessOrEquals(item()?['due'], convertFromUtc(utcNow(), 'Eastern Standard Time', 'yyyy-MM-dd'))
   ```

   Dates are `YYYY-MM-DD`, so comparing them as text compares them as dates. That's why the expression works.

7. **Condition**: `length(body('Due'))` is greater than `0`.
   - **If yes:**
     1. **Create HTML table.** For **From**, choose `body('Due')`. Set **Columns** to **Custom**, with these four columns:

        | Header | Value |
        | --- | --- |
        | Due | `item()?['dueText']` |
        | Task | `item()?['task']` |
        | For | `item()?['for']` |
        | Amount | `item()?['amount']` |
     2. **Office 365 Outlook › Send an email (V2).**
        - **To:** `sendTo` from Parse JSON.
        - **Subject:** `AlmsManager: @{length(body('Due'))} alms task(s) due`
        - **Body:** a line such as "These alms tasks are due. Open AlmsManager and mark each one done when it's taken care of; this email comes every morning until then.", followed by the **Output** of Create HTML table.
   - **If no:** leave it empty, so nothing is sent. Or see [A weekly all-clear](#a-weekly-all-clear).

8. **After the scope, outside it:** add **Send an email (V2)** to yourself, with the subject `AlmsManager reminders failed`. On this action, choose **Settings › Run after**, untick **is successful**, and tick **has failed** and **has timed out** for `Try`. Without this, a broken flow is just silence, which looks the same as "nothing due."

9. **Save**, then **Test › Manually**. If a task is due today, the email arrives. To try it before anything is due, approve a test case in AlmsManager starting today; its first payment is due at once. Afterwards, use **Close case** to stop its reminders. It stays on the Cases page as closed.

## A weekly all-clear

To make sure the flow's silence means "nothing due" and not "something broke," have it send a short note on Mondays when nothing is due. In the **If no** branch, add a **Condition** with this expression:

```
dayOfWeek(convertFromUtc(utcNow(), 'Eastern Standard Time'))
```

Set it to equal `1`. Under its **If yes**, add a **Send an email (V2)** to `sendTo` with the subject `AlmsManager: no alms tasks due`.

## If something goes wrong

- **No email, and none expected?** AlmsManager's **Tasks** page shows what's due. If it shows something due and no email came, open the flow's run history.
- **The run failed at Send an email.** Check that **Settings › Reminder email** in AlmsManager isn't empty. The banner in AlmsManager says so when it is.
- **The email lists something already done.** The computer it was marked done on may not have synced yet, or AlmsManager couldn't write the file. **Settings › Power Automate** in AlmsManager shows when the file last changed, and any problem writing it.
- **Microsoft 365 permissions:** the flow account needs read access to the AB Apps folder, and a mailbox to send from. Nothing else in AlmsManager depends on that account.
