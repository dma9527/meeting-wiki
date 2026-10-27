# Job States and Recovery Actions

[English](job-states.md)

Every meeting you record or import becomes one job in the local queue. This page lists every state a job can be in, what the app does with it on its own, and what you can do. A test reads the table below and runs each action against a real queue, so the table cannot drift from the code.

## State matrix

| State | What it means | Automatic | Retry | Dismiss | Restore |
|---|---|---|---|---|---|
| `pending` | Waiting for the worker. | `claim` | no | no | no |
| `running` | The worker holds a lease and is processing it. | `reclaim` | no | no | no |
| `failed` | An attempt failed and more attempts remain. It waits for its backoff time. | `claim` | yes | no | no |
| `dead` | Every attempt failed. The app stops trying and shows it under **Processing recovery**. | `none` | yes | yes | no |
| `done` | Finished. | `none` | no | no | no |
| `dismissed` | A dead job you chose to hide. Its recording, transcript, and wiki pages are kept. | `none` | no | no | yes |

The Automatic column is what the worker does with the job on its next loop: `claim` starts it, `reclaim` takes it back from a worker that stopped renewing its lease, and `none` leaves it alone. Retry, Dismiss, and Restore are the actions in **Processing recovery** and the matching `meeting-wiki retry`, `dismiss`, and `restore` commands. "no" means the action is refused for that state and nothing changes.

## How a job moves

- A new job starts as `pending`. The worker claims it, which makes it `running` and counts one attempt.
- If the attempt succeeds the job is `done`.
- If it fails and attempts remain, the job is `failed` and is tried again after a delay that doubles each time. The delay starts at `backoff_base_seconds`. With the defaults, the waits are 2, 4, 8, and 16 seconds.
- If the attempts are used up, the job is `dead`.
- **Retry** on a `failed` or `dead` job puts it back to `pending` with a fresh set of attempts and clears its last error.
- **Dismiss** moves a `dead` job to `dismissed`. **Restore** moves it back to `dead`. Dismissed jobs older than the retention period can be removed with `meeting-wiki cleanup-dismissed`, which deletes only the queue row.

Defaults, all under `[jobs]` in the configuration:

- `max_attempts` is 5.
- `backoff_base_seconds` is 2.
- `visibility_timeout_seconds` is 3600.

## Stalled work

### Jobs wait and nothing runs

The worker is not running or cannot start. The usual cause is a provider key that cannot be read, which pauses processing and shows a notification once.

1. Choose **Run self-check...** and read the first line that needs attention.
2. If the key is the problem, run setup again from the menu.
3. Saving anything in **Settings** restarts the worker. Otherwise quit and reopen Meeting Wiki.

Waiting jobs are not lost. They are claimed as soon as the worker is back.

### A job is running for a long time

A running job renews its lease about every 30 seconds. If the worker stops renewing it, for example because the app quit mid-job, the lease runs out after `visibility_timeout_seconds` and the next worker loop takes the job back. It becomes `pending` if attempts remain and `dead` if they do not. You do not need to do anything, and Retry is refused for a `running` job.

A long recording can legitimately take a long time to process. Check `meeting-wiki status --summary` before you assume it is stuck.

### A job is dead

1. Read the failure code: `meeting-wiki status --state dead`, or open **Processing recovery**.
2. Fix the cause. A provider error code such as an HTTP status or a closed connection usually means the provider account or network. A missing audio file means the recording is gone.
3. Run `meeting-wiki retry JOB_ID`, or use **Retry job** in the window. Use **Retry all** only when the same cause affected several jobs.
4. If you do not want the job back, run `meeting-wiki dismiss JOB_ID`. Nothing about the meeting is deleted.

Retrying a job whose audio or transcript no longer exists fails again and ends up `dead`. Dismiss it instead.
