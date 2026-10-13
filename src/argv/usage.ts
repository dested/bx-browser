// bx --help. Printed by the CLI for help and by both the CLI and the daemon's
// /argv route after an unknown command.

export const USAGE = `bx — browser automation for Claude Code

Usage: bx [--profile <name>] [--headless] [--json] <command> [args]

Navigation
  open <url>                       open a url, then print its interactive elements
  back                             go back in history
  reload                           reload the current page
  tabs                             list open tabs
  tab <n>                          switch to tab n
  tab new [url]                    open a new tab
  tab close [--others|--all]       close the active tab; --others keeps it, --all closes every tab

Observation
  els [--all] [--filter <text>]    interactive elements as [ref] role "name"
      [--diff] [--clickables]      --diff: only what changed since the last els;
                                   --clickables: also cursor:pointer divs
  text [target] [--md]             visible text of the main content, or of one
                                   target; --md keeps headings, lists and links
  snap [path] [--full]             screenshot, downscaled; --full for whole page
       [--el <target>] [--jpeg]    --el crops to one element; a .jpg path or
       [--quality <n>] [--stable]  --quality implies --jpeg; --stable waits for
                                   two identical frames
  console [--all] [--filter <re>]  console entries (errors + warnings by default)
          [--all-tabs]
  net [--failed] [--all]           network requests: xhr, fetch and documents;
      [--filter <re>] [--all-tabs] --all for every resource type
  net body <id>                    response body of a request listed by net
  js <code | - | @file.js>         run JS in the page: an expression, or statements
                                   whose last expression is the result; - reads
                                   stdin, @file reads a file (no shell quoting)
  status                           daemon, browser, tabs and recording state

Interaction  (<target> = @ref | text:<t> | testid:<id> | label:<l> | role:<role>[:<name>]
              | selector (#, ., [, //, css=, xpath=) | visible text. A bare
              number is a ref when that ref exists, otherwise text. The best
              match wins (exact name > exact text > prefix > substring); a tie
              is an "ambiguous" error listing the candidates. --exact: exact
              matches only; --first: take the first of a tie)
  click <target>                   click an element
  fill <target> <value>            set an input's value (finds the input inside
                                   a labelled wrapper)
  press <key>                      press a key, e.g. Enter or Control+a
  select <target> <value>          pick by value or label in a <select> or an
                                   ARIA combobox
  wait <ms | selector | text>      sleep, or wait for a selector or visible text
       | --idle | --gone <target>  ...or until network + DOM are quiet, a target
       | --url <part> | --js <e>   is gone, the url contains <part>, or <e> is truthy
  expect <kind> <value>            assert; kind = text | url | visible | not-visible

  Every action (click fill press select back reload mouse drag key wheel) takes:
  --then els|text|snap             append an observation to the same result
  --until <text>                   after the action, wait for this text to show
  --settle <ms>                    cap the post-action settle (0 skips it; by
                                   default it waits for the DOM and the
                                   action's requests to go quiet)
  and reports what changed: url, title, dialog, alerts, dom +added −removed,
  focus, a new background tab.

Canvas / coordinates  (games and non-semantic UIs; with --in <target>, x and y
are relative to that element's top-left, otherwise to the viewport)
  mouse <action> <x> <y>           action = click | dblclick | move | down | up
                                   [--in <target>] [--button left|right|middle]
  drag <x1> <y1> <x2> <y2>         press, move and release [--in <target>]
                                   [--steps <n>] (default 10 intermediate moves)
                                   [--pointer] [--hold <ms>] [--step-delay <ms>]
                                   --pointer dispatches PointerEvents instead of
                                   mouse events, for touch-none / pointer-intent
                                   DnD that never sees a mouse
  key <down|up> <key>              hold or release a key, e.g. w — press is the
                                   one-shot version
  wheel <deltaY> [x y]             scroll; x y moves the pointer first
                                   [--in <target>]
  drive --install "<js>"           install an in-page controller and poll a
        --until "<expr>"           predicate to truthy — zero model tokens
                                   [--timeout <ms>] (default 15000)
                                   [--poll <ms>] (default 500)

Flows and automation
  run <flow.ts> [--record]         replay a typed flow file (zero model tokens)
  record start [slug]              record one tab, no relaunch (default slug rec-<date-time>)
         [--tab <id> | --follow]   --tab: that tab, not the active one; --follow: move
         [--ring <secs>]           with the active tab; --ring: keep only the newest secs in
         [--fps 30|60]             memory and write nothing until save/stop
  record mark "<text>"             a chapter marker in the transcript and report
  record stop [--distill] [--mp4]  package under recordings/<slug>/: video.webm, transcript.txt,
                                   recording.json; report.md distills in the background
                                   (--distill waits for it; --mp4 needs ffmpeg with libx264)
  record save --last <secs>        ring mode: package the newest secs while recording goes on
              [slug] [--mp4]
  record status                    what is recording, and which reports are still distilling
  record distill <dir>             re-run distill on a package (writes report.md)
  agent "<instruction>"            let a cheap model drive; prints a short report
                                   [--model haiku|sonnet|opus] [--opus]
                                   [--save <name>] [--max-turns <n>] [--verbose]
                                   [--budget <usd>] [--max-wall <s>]
                                   [--url <u>] [--enter <js>] [--win <expr>]
                                   [--vision]
                                   --opus allows one final escalation to Opus 5.5
                                   — complex flows only, ~2× Sonnet cost
                                   --vision lets the model see screenshots
                                   (canvas/game pages; costs image tokens)
                                   --budget/--max-wall abort the run at that
                                   estimated spend or elapsed time and still
                                   print a report
                                   --url opens the agent's tab there; --enter
                                   <js> runs once before the first turn (kills
                                   entry discovery on canvas apps); --win <expr>
                                   is the success predicate — verified before a
                                   pass is accepted

Batch  (one process, many commands: ~1-3 ms each after the first)
  -                                read commands from stdin, one per line
  do "<cmd>; <cmd>; ..."           run several commands from one argument
                                   both stop at the first failure unless
                                   --keep-going; --json prints one line each

Setup
  install-skill                    copy the bx skill into ~/.claude/skills/bx so
                                   Claude Code reaches for bx on its own

Daemon
  profiles                         list profiles and which are running
  doctor [--fix]                   find orphaned Chromes, stale run files, profile
                                   locks, leaked recording scratch, big logs;
                                   --fix cleans what it safely can
  gc [--older-than 14d] [--keep a,b] [--caches] [--yes]
                                   list profiles unused for 14+ days with sizes;
                                   --yes deletes them (never "default" or a
                                   running one); --caches also empties every
                                   profile's HTTP/code/GPU caches
  stop [--all]                     shut this profile's daemon down; --all stops
                                   every daemon. Idle daemons also exit on their
                                   own after 15 min (BX_IDLE_MINUTES, 0 = never)
  help                             this text

Flags
  --profile <name>                 browser session to use (default: "default")
  --headless                       launch headless when starting the daemon
  --timeout <ms>                   override the 5000ms default on click, fill,
                                   select, wait and expect
  --deadline <ms>                  give up on a command after this long (default
                                   10000, or --timeout + 5000 when longer)
  --json                           print raw JSON instead of text; exit code unchanged
  -h, --help                       this text, from anywhere in the command line

Output is token-budgeted at the source: els <= 100 elements / 3200 chars, text
<= 8000 chars, js <= 4000 chars, console and net <= 30 entries each.

Set BX_TIMING=1 to print each command's wall time to stderr; --json output
carries the same number as an "ms" field.

Exit codes: 0 ok | 1 command or assertion failed | 2 usage error | 3 daemon or
browser failure.
`;
