import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { commandArgsOf, commandArgsRecordOf, commandTool, exitOfJobDetail, firstLineOf, headProgramOf, hideableCdPrefix, markersOfText, outcomeOfMarkers, programsOfCommand, shapeOfCmd, signalOfJobDetail } from '../../src/shared/commands'
import { opsOfCall, parseCallArgs } from '../../src/shared/fileOps'

describe('commands', () => {

describe('commandTool', () => {
  test('the shell tools and run_code are command-bearing; everything else is not', () => {
    assert.equal(commandTool('bash'), 'bash')
    assert.equal(commandTool('pwsh'), 'pwsh')
    assert.equal(commandTool('run_code'), 'run_code')
    assert.equal(commandTool('read'), null)
    assert.equal(commandTool('job_output'), null)
    assert.equal(commandTool(undefined), null)
    assert.equal(commandTool('bashful'), null)
  })
})

describe('commandArgsOf', () => {
  test('parses the durable JSON-string and normalized object forms with every field', () => {
    const parsed = commandArgsOf('bash', JSON.stringify({
      command: 'git status',
      description: 'check the tree',
      workdir: '/repo',
      timeoutMs: 5000,
      run_in_background: true,
      sandbox_permissions: 'full',
    }), 4096)
    assert.deepEqual(parsed, {
      cmd: 'git status',
      description: 'check the tree',
      cwd: '/repo',
      timeoutMs: 5000,
      background: true,
      sandbox: 'full',
    })
    const code = commandArgsOf('run_code', JSON.stringify({ code: 'const x = 1', description: 'compute' }), 4096)
    assert.deepEqual(code, { cmd: 'const x = 1', description: 'compute' })
    const ptc = commandArgsOf('bash', { command: 'ls', description: 'list' }, 4096)
    assert.deepEqual(ptc, { cmd: 'ls', description: 'list' })
  })

  test('caps an overlong command; a command-less or unreadable payload books nothing; junk fields drop silently', () => {
    const parsed = commandArgsOf('bash', JSON.stringify({ command: 'x'.repeat(100) }), 10)
    assert.equal(parsed?.cmd, 'x'.repeat(10))
    assert.equal(parsed?.truncated, true)
    assert.equal(commandArgsOf('bash', JSON.stringify({ description: 'no command' }), 4096), null)
    assert.equal(commandArgsOf('bash', 'not json', 4096), null)
    assert.equal(commandArgsOf('bash', '[1,2]', 4096), null)
    assert.equal(commandArgsOf('bash', undefined, 4096), null)
    assert.equal(commandArgsOf('run_code', JSON.stringify({ command: 'ls' }), 4096), null)
    const junk = commandArgsOf('bash', JSON.stringify({
      command: 'ls',
      timeoutMs: -3,
      run_in_background: 'yes',
      description: 7,
      workdir: '',
    }), 4096)
    assert.deepEqual(junk, { cmd: 'ls' })
  })
})

describe('commandArgsRecordOf', () => {
  test('normalizes the string and object forms and rejects the rest', () => {
    assert.deepEqual(commandArgsRecordOf('{"a":1}'), { a: 1 })
    assert.deepEqual(commandArgsRecordOf({ a: 1 }), { a: 1 })
    assert.equal(commandArgsRecordOf('nope'), null)
    assert.equal(commandArgsRecordOf(42), null)
    assert.equal(commandArgsRecordOf(null), null)
    assert.equal(commandArgsRecordOf([1]), null)
  })
})

describe('markersOfText', () => {
  test('a clean exit carries no marker; the exit marker anchors at the very tail, like dsh’s own parser', () => {
    assert.deepEqual(markersOfText('total 8\nfile.ts'), {})
    assert.deepEqual(markersOfText('boom\n[exit code: 3]'), { exit: 3 })
    assert.deepEqual(markersOfText('[exit code: 3]\nmore output'), {})
  })

  test('the persistent-shell family reads exits, OOM timeouts, shell kills and resets', () => {
    assert.deepEqual(markersOfText('ok\n[Command finished with exit code 0]'), { exit: 0 })
    assert.deepEqual(markersOfText('bad\n[Command finished with exit code 2]'), { exit: 2 })
    assert.deepEqual(markersOfText('out\n[Command timed out or OOM]\n[shell reset]'), { timedOut: true })
    assert.deepEqual(markersOfText('out\n[shell killed by signal: SIGKILL]\nreset'), { signal: 'SIGKILL' })
    assert.deepEqual(markersOfText('out\n[shell exited: code 3]\nreset'), { exit: 3 })
    assert.deepEqual(markersOfText('out\n[shell exited]'), { stopped: true })
  })

  test('a kill reports the signal instead of an exit code', () => {
    assert.deepEqual(markersOfText('partial\n[killed by signal: SIGTERM]'), { signal: 'SIGTERM' })
  })

  test('timeout, stop, denial, truncation and stderr are independent flags', () => {
    assert.deepEqual(markersOfText('out\n[timed out after 5000ms]'), { timedOut: true })
    assert.deepEqual(markersOfText('out\n[stopped: user request]'), { stopped: true })
    assert.deepEqual(markersOfText('[sandbox: file access denied under strict mode]'), { denied: true })
    assert.deepEqual(markersOfText('partial\n[output truncated; full output: /tmp/x]'), { truncated: true })
    assert.deepEqual(markersOfText('out\n[stderr]\nboom'), { stderr: true })
    const several = markersOfText('o\n[stderr]\ne\n[timed out after 5ms]\n[exit code: 28]')
    assert.deepEqual(several, { stderr: true, timedOut: true, exit: 28 })
  })

  test('a background hand-off is an ack, not an outcome', () => {
    assert.deepEqual(markersOfText('started background job abc123'), { backgroundAck: true })
    const realPromoted = 'partial output\n[still running after 10000ms; moved to background job abc123]\n'
      + 'The command keeps running in the background. You will be notified when it finishes; '
      + 'read newer output with job_output, stop it with job_kill.'
    assert.deepEqual(markersOfText(realPromoted), { backgroundAck: true })
    assert.deepEqual(markersOfText('partial output\n[still running after 10000ms; moved to background job abc123]'), { backgroundAck: true })
    assert.deepEqual(markersOfText('[still running after 10ms; moved to background job x]\nother output'), {})
  })

  test('hostile text yields no markers', () => {
    assert.deepEqual(markersOfText(''), {})
    assert.deepEqual(markersOfText('[exit code: abc]'), {})
    assert.deepEqual(markersOfText('[killed by signal: ]'), {})
  })
})

describe('outcomeOfMarkers', () => {
  test('killed beats failed beats completed; the inferred clean exit is flagged', () => {
    assert.deepEqual(outcomeOfMarkers({ signal: 'SIGKILL' }, false), { status: 'killed' })
    assert.deepEqual(outcomeOfMarkers({ stopped: true }, false), { status: 'killed' })
    assert.deepEqual(outcomeOfMarkers({ exit: 2 }, false), { status: 'failed', exit: 2 })
    assert.deepEqual(outcomeOfMarkers({ denied: true }, false), { status: 'failed' })
    assert.deepEqual(outcomeOfMarkers({}, true), { status: 'failed' })
    assert.deepEqual(outcomeOfMarkers({ timedOut: true }, false), { status: 'failed' })
    assert.deepEqual(outcomeOfMarkers({ timedOut: true, exit: 0 }, false), { status: 'completed', exit: 0 })
    assert.deepEqual(outcomeOfMarkers({ exit: 0 }, false), { status: 'completed', exit: 0 })
    assert.deepEqual(outcomeOfMarkers({}, false), { status: 'completed', exit: 0, exitInferred: true })
  })
})

describe('job detail parsing', () => {
  test('the exit code and signal read out of the detail line, including with sandbox notes appended', () => {
    assert.equal(exitOfJobDetail('exit code: 3'), 3)
    assert.equal(exitOfJobDetail('exit code: 0; [sandbox: file access denied under strict mode]'), 0)
    assert.equal(exitOfJobDetail('killed before exit'), undefined)
    assert.equal(exitOfJobDetail(undefined), undefined)
    assert.equal(exitOfJobDetail(42), undefined)
    assert.equal(signalOfJobDetail('signal: SIGTERM'), 'SIGTERM')
    assert.equal(signalOfJobDetail('signal: SIGKILL; [sandbox: x]'), 'SIGKILL')
    assert.equal(signalOfJobDetail('exit code: 1'), undefined)
    assert.equal(signalOfJobDetail(null), undefined)
  })
})

describe('display shaping', () => {
  test('firstLineOf takes the first line of a multi-line command', () => {
    assert.equal(firstLineOf('ls'), 'ls')
    assert.equal(firstLineOf('git status\ngit diff'), 'git status')
    assert.equal(firstLineOf('  indented  '), 'indented')
  })

  test('the hideable cd prefix is exactly the workspace one', () => {
    assert.equal(hideableCdPrefix('cd /repo && git status', '/repo'), 'cd /repo && '.length)
    assert.equal(hideableCdPrefix('cd /repo/ && git status', '/repo'), 'cd /repo/ && '.length)
    assert.equal(hideableCdPrefix('cd /repo && git status', '/repo/'), 'cd /repo && '.length)
    assert.equal(hideableCdPrefix('cd "/my repo" && ls', '/my repo'), 'cd "/my repo" && '.length)
    assert.equal(hideableCdPrefix('cd /elsewhere && ls', '/repo'), 0)
    assert.equal(hideableCdPrefix('git status', '/repo'), 0)
    assert.equal(hideableCdPrefix('cd /repo && ls', undefined), 0)
    assert.equal(hideableCdPrefix('cd /repo && ls', ''), 0)
    assert.equal(hideableCdPrefix('cd /repo && ls', '/'), 0)
  })

  test('shapeOfCmd counts lines and spots heredocs and inline scripts', () => {
    assert.deepEqual(shapeOfCmd('git status'), { lines: 1, heredoc: false, inline: false })
    assert.deepEqual(shapeOfCmd('cat <<\'EOF\'\nbody\nEOF'), { lines: 3, heredoc: true, inline: false })
    assert.deepEqual(shapeOfCmd('node -e "console.log(1)"'), { lines: 1, heredoc: false, inline: true })
    assert.deepEqual(shapeOfCmd('python3 -c \'print(1)\''), { lines: 1, heredoc: false, inline: true })
    assert.deepEqual(shapeOfCmd('git diff | node -e "x"'), { lines: 1, heredoc: false, inline: true })
    assert.deepEqual(shapeOfCmd('echo "a <<- not a heredoc in spirit but matches the cheap test"'), { lines: 1, heredoc: true, inline: false })
  })

  test('headProgramOf parses POSIX scaffolding: wrappers, assignments, separators, and partial text', () => {
    assert.equal(headProgramOf('git status'), 'git')
    assert.equal(headProgramOf('cd /repo && git status'), 'git')
    assert.equal(headProgramOf('cd "/my repo" && pnpm run build'), 'pnpm')
    assert.equal(headProgramOf('FOO=1 BAR=2 node x.mjs'), 'node')
    assert.equal(headProgramOf('env A=1 node x.mjs'), 'node')
    assert.equal(headProgramOf('sudo rm -rf /tmp/x'), 'rm')
    assert.equal(headProgramOf('sudo -E node x.mjs'), 'node', 'wrapper flags unwrap too')
    assert.equal(headProgramOf('sudo -u bob git status'), 'git', 'a wrapper flag value is not the program')
    assert.equal(headProgramOf('timeout 30 curl -s https://x'), 'curl')
    assert.equal(headProgramOf('timeout -s KILL 5 curl -s x'), 'curl')
    assert.equal(headProgramOf('env -i FOO=bar node x'), 'node')
    assert.equal(headProgramOf('nohup pnpm dev &'), 'pnpm')
    assert.equal(headProgramOf('/usr/local/bin/python3 - <<\'PY\''), 'python3')
    assert.equal(headProgramOf('for f in a b; do echo $f; done'), 'shell')
    assert.equal(headProgramOf('{ pnpm run build; } >> log'), 'shell')
    assert.equal(headProgramOf('(cd /repo && git status)'), 'shell', 'a group is a shell construct')
    assert.equal(headProgramOf(''), '')
    assert.equal(headProgramOf('   '), '')
    assert.equal(headProgramOf('FOO=bar; echo hi'), 'echo', 'a standalone assignment hands off to the next command')
    assert.equal(headProgramOf('FOO=bar'), 'shell', 'an assignment-only command has no program')
    assert.equal(headProgramOf('FOO="a b" node x.mjs'), 'node', 'quoted assignment values may contain spaces')
    assert.equal(headProgramOf('arr=(a b); echo hi'), 'echo', 'an array assignment is scaffolding')
    assert.equal(headProgramOf('PATH+=:/opt/bin; git status'), 'git', 'an append assignment is scaffolding')
    assert.equal(headProgramOf('X+=bar; "$X"'), 'shell', 'an appended value is not a whole program')
    assert.equal(headProgramOf('export CH="a b"; echo hi'), 'echo', 'a declaration hands off to the next command')
    assert.equal(headProgramOf('export FOO=bar'), 'shell', 'a declaration alone has no program')
    assert.equal(headProgramOf('export FOO'), 'shell', 'a declared name alone has no program')
    assert.equal(headProgramOf('export -p'), 'shell', 'a declaration flag alone has no program')
    assert.equal(headProgramOf('URL=$(cat .tmp/dsh-web-url.txt); chrome-devtools new_page "$URL" --timeout 30'), 'chrome-devtools')
    assert.equal(headProgramOf('CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; "$CH" --headless'), 'Google Chrome')
    assert.equal(headProgramOf('CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; "${CH}" --headless'), 'Google Chrome')
    assert.equal(headProgramOf('B=/usr/bin; "$B/python3" --version'), 'python3', 'a prefixed variable resolves')
    assert.equal(headProgramOf('B=/usr/bin; "$B/$UNSET"'), 'shell', 'an unresolved suffix does not invent a program')
    assert.equal(headProgramOf('B=$(cmd); "$B/x"'), 'x', 'a literal suffix still names a program')
    assert.equal(headProgramOf('a$b'), 'shell', 'an embedded expansion does not name a program')
    assert.equal(headProgramOf('"$UNSET" --foo'), 'shell', 'an unresolved variable does not invent a program')
    assert.equal(headProgramOf('"$(which node)" --version'), 'shell', 'a command substitution does not name a program')
    assert.equal(headProgramOf('"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version'), 'Google Chrome')
    assert.equal(headProgramOf('"/c/Program Files/Git/bin/bash.exe" -lc "echo hi"'), 'bash', 'Git Bash paths unquote and drop .exe')
    assert.equal(headProgramOf('C:\\Windows\\System32\\cmd.exe /c dir'), 'cmd', 'Windows paths use the backslash basename')
    assert.equal(headProgramOf('# note\ngit status'), 'git', 'a leading comment line is skipped')
  })

  test('headProgramOf reads PowerShell statements, call operators and variables', () => {
    assert.equal(headProgramOf('Get-ChildItem | Select-Object Name', 'pwsh'), 'Get-ChildItem')
    assert.equal(headProgramOf('& "C:\\Program Files\\Google\\Chrome\\chrome.exe" --version', 'pwsh'), 'chrome')
    assert.equal(headProgramOf('$exe = "C:\\Tools\\foo.exe"; & $exe --x', 'pwsh'), 'foo')
    assert.equal(headProgramOf("$exe = 'C:\\Tools\\foo.exe'; . $exe", 'pwsh'), 'foo')
    assert.equal(headProgramOf('$env:FOO = "bar"; cmd /c dir', 'pwsh'), 'cmd')
    assert.equal(headProgramOf('cmd.exe /c dir', 'pwsh'), 'cmd')
    assert.equal(headProgramOf('Start-Process notepad', 'pwsh'), 'Start-Process')
    assert.equal(headProgramOf('$x = Get-Date; $x', 'pwsh'), 'pwsh', 'an expression result does not name a program')
    assert.equal(headProgramOf('$x = 1', 'pwsh'), 'pwsh', 'an assignment-only script has no program')
    assert.equal(headProgramOf('& $unknown', 'pwsh'), 'pwsh', 'an unresolved variable does not invent a program')
    assert.equal(headProgramOf('if ($x) { Get-Item y }', 'pwsh'), 'pwsh', 'a control statement has no head program')
    assert.equal(headProgramOf('', 'pwsh'), '')
  })

  test('headProgramOf survives partial and defensive command and PowerShell text', () => {
    assert.equal(headProgramOf('FOO="a'), 'shell')
    assert.equal(headProgramOf('FOO="$BAR"'), 'shell')
    assert.equal(headProgramOf('FOO=`cmd`'), 'shell')
    assert.equal(headProgramOf('FOO=`cmd'), 'shell')
    assert.equal(headProgramOf('FOO=$BAR'), 'shell')
    assert.equal(headProgramOf('FOO="a\\"b"'), 'shell')
    assert.equal(headProgramOf('FOO=$(echo "a)b"); echo'), 'echo')
    assert.equal(headProgramOf('FOO=$(echo "a'), 'shell')
    assert.equal(headProgramOf('FOO=$(echo'), 'shell')
    assert.equal(headProgramOf('"a\\"b"'), 'a"b')
    assert.equal(headProgramOf('"foo'), 'foo')
    assert.equal(headProgramOf('my\\ cmd'), 'my cmd')
    assert.equal(headProgramOf('""'), 'shell')
    assert.equal(headProgramOf(';;;'), 'shell')
    assert.equal(headProgramOf('# note'), 'shell')
    assert.equal(headProgramOf('! git status'), 'git')
    assert.equal(headProgramOf('cd '), 'cd')
    assert.equal(headProgramOf('cd /x'), 'cd')
    assert.equal(headProgramOf('export '), 'shell')
    assert.equal(headProgramOf('export ; echo'), 'echo')
    assert.equal(headProgramOf('export ""'), 'shell')
    assert.equal(headProgramOf('timeout ""'), 'shell')
    assert.equal(headProgramOf('command -v node'), 'command')
    assert.equal(headProgramOf('sudo'), 'sudo')
    assert.equal(headProgramOf('sudo ; git'), 'sudo')
    assert.equal(headProgramOf('sudo -- git status'), 'git')
    assert.equal(headProgramOf('sudo -u'), 'sudo')
    assert.equal(headProgramOf('sudo -u '), 'sudo')
    assert.equal(headProgramOf('sudo > out'), 'sudo')
    assert.equal(headProgramOf('>'), 'shell')
    assert.equal(headProgramOf('cd /x;'), 'cd')
    assert.equal(headProgramOf('"$UNSET-suffix"'), 'shell')
    assert.equal(headProgramOf('$x = "foo', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('$x = "a $b"; $x', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('$x = "foo" + "bar"; $x', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('$x = "foo" + "a;b"; $x', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('$x = "foo" + "a;b', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('$env:FOO = "foo.exe"; & $env:FOO', 'pwsh'), 'foo')
    assert.equal(headProgramOf('& ${x}', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('& "a`b"', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('$x = "a`"b"; & $x', 'pwsh'), 'a"b')
    assert.equal(headProgramOf('& $(Get-Item x)', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('(Get-Item x)', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('[int]::Parse("1")', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('{ Get-Item x }', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('@args', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf(';;;', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('# note\nGet-Item x', 'pwsh'), 'Get-Item')
    assert.equal(headProgramOf('# only', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('&', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('""', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('$x = )', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('$x = ]', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('$x = }', 'pwsh'), 'pwsh')
  })

  test('headProgramOf reads navigation, guards, wrappers and platform paths', () => {
    assert.equal(headProgramOf('cd /repo; git status'), 'git')
    assert.equal(headProgramOf('cd /repo\ngit status'), 'git')
    assert.equal(headProgramOf('cd /repo 2>/dev/null && git status'), 'git')
    assert.equal(headProgramOf('cd -P /repo && git status'), 'git')
    assert.equal(headProgramOf('cd -- /repo && git status'), 'git')
    assert.equal(headProgramOf('cd /repo 2>/dev/null'), 'cd', 'a lone redirected cd stays the head')
    assert.equal(headProgramOf('2>/dev/null git status'), 'git')
    assert.equal(headProgramOf('> out echo hi'), 'echo')
    assert.equal(headProgramOf('exec 3>&1'), 'exec', 'redirection-only exec stays exec')
    assert.equal(headProgramOf('exec 3>&1 # comment'), 'exec')
    assert.equal(headProgramOf('exec 3>file git status'), 'git')
    assert.equal(headProgramOf('sudo -iu postgres psql -c "select 1"'), 'psql', 'a combined sudo value flag unwraps')
    assert.equal(headProgramOf('sudo -uroot psql -c "select 1"'), 'psql', 'an attached sudo value still finds the command')
    assert.equal(headProgramOf('sudo -uubuntu psql'), 'psql')
    assert.equal(headProgramOf('sudo -AE node x'), 'node')
    assert.equal(headProgramOf('sudo -p "Password: " git status'), 'git', 'a quoted flag value may contain spaces')
    assert.equal(headProgramOf('sudo -p"Password:" git status'), 'git', 'an attached quoted flag value unwraps')
    assert.equal(headProgramOf('command -pv node'), 'command', 'a combined command query is not the program')
    assert.equal(headProgramOf('command -p node x'), 'node')
    assert.equal(headProgramOf('time -f "%e" sleep 1'), 'sleep')
    assert.equal(headProgramOf('caffeinate -w 1234 npm test'), 'npm')
    assert.equal(headProgramOf('nice -n 10 node x'), 'node')
    assert.equal(headProgramOf('stdbuf -oL grep x'), 'grep')
    assert.equal(headProgramOf('doas -u bob git status'), 'git')
    assert.equal(headProgramOf('noglob git status'), 'git')
    assert.equal(headProgramOf('nocorrect git status'), 'git')
    assert.equal(headProgramOf('ROOT="/a"/b npm test'), 'npm', 'a quoted assignment prefix keeps the next command')
    assert.equal(headProgramOf('DIR="$PWD"/out pnpm build'), 'pnpm')
    assert.equal(headProgramOf('OUT="/tmp"/x make'), 'make')
    assert.equal(headProgramOf('FOO="a""b c" echo hi'), 'echo', 'a quoted suffix keeps its spaces inside')
    assert.equal(headProgramOf('FOO="a""b echo'), 'shell')
    assert.equal(headProgramOf('X=$(cmd)/suffix echo hi'), 'echo')
    assert.equal(headProgramOf('$HOME/bin/tool --x'), 'tool', 'an unresolved prefix still yields a literal basename')
    assert.equal(headProgramOf('$UNSET/$X'), 'shell', 'an unresolved suffix basename falls back')
    assert.equal(headProgramOf('export A=1\ngit status'), 'git', 'a declaration does not cross the newline')
    assert.equal(headProgramOf('export NVM_DIR="$HOME/.nvm"\n[ -s x ] && . x'), 'shell')
    assert.equal(headProgramOf('[[ -f package.json ]] && pnpm test'), 'shell')
    assert.equal(headProgramOf('[ -d .git ] && git status'), 'shell')
    assert.equal(headProgramOf('deploy() { echo hi; }'), 'shell', 'a function definition has no program head')
    assert.equal(headProgramOf('deploy () { echo hi; }'), 'shell')
    assert.equal(headProgramOf('my-func(){ echo hi; }'), 'shell')
    assert.equal(headProgramOf('function deploy { echo hi; }'), 'shell')
    assert.equal(headProgramOf('for((i=0;i<3;i++)); do echo x; done'), 'shell')
    assert.equal(headProgramOf('npm.cmd run build'), 'npm', 'Windows .cmd drops from the identity')
    assert.equal(headProgramOf('build.BAT'), 'build')
    assert.equal(headProgramOf('.exe'), '.exe', 'an extension-only word is not emptied')
    assert.equal(headProgramOf('cd /repo && \\\npnpm build'), 'pnpm', 'a line continuation is skipped')
  })

  test('headProgramOf reads PowerShell expressions, compound assignments and nested statements', () => {
    assert.equal(headProgramOf('$x = "foo"; $x', 'pwsh'), 'pwsh', 'a bare variable is an expression, not an invocation')
    assert.equal(headProgramOf('$x = "foo"; & $x', 'pwsh'), 'foo')
    assert.equal(headProgramOf("'hello'", 'pwsh'), 'pwsh', 'a quoted string alone is an expression')
    assert.equal(headProgramOf('-not $x', 'pwsh'), 'pwsh', 'a unary operator is an expression')
    assert.equal(headProgramOf('1..10 | % { $_ }', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('$job = Start-Job { npm test; Start-Sleep 1 }; Wait-Job $job', 'pwsh'), 'Wait-Job')
    assert.equal(headProgramOf('$env:PATH += ";C:\\Tools"; npm test', 'pwsh'), 'npm')
    assert.equal(headProgramOf('$x[0] = 1; Get-Item x', 'pwsh'), 'Get-Item')
    assert.equal(headProgramOf('$obj.Name = "x"; Get-Item x', 'pwsh'), 'Get-Item')
    assert.equal(headProgramOf('[Console]::OutputEncoding = [Text.Encoding]::UTF8; chcp 65001', 'pwsh'), 'chcp')
    assert.equal(headProgramOf('if(Test-Path x){ Get-Item y }', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('npm.cmd --version', 'pwsh'), 'npm')
    assert.equal(headProgramOf('& "$env:SystemRoot\\System32\\cmd.exe" /c dir', 'pwsh'), 'cmd')
    assert.equal(headProgramOf('$dir = "C:\\Tools"; & "$dir\\foo.exe"', 'pwsh'), 'foo')
    assert.equal(headProgramOf('$env:PATH += ";C:\\Tools"; & $env:PATH', 'pwsh'), 'pwsh', 'an appended value is not resolved')
    assert.equal(headProgramOf('$x = "foo.exe" # note\n& $x', 'pwsh'), 'foo', 'a trailing comment ends the assignment')
    assert.equal(headProgramOf('2>$null Get-Item x', 'pwsh'), 'Get-Item')
    assert.equal(headProgramOf('2>$null', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('cd C:\\repo; npm test', 'pwsh'), 'npm')
    assert.equal(headProgramOf('Set-Location -Path C:\\repo; Get-Item x', 'pwsh'), 'Get-Item')
    assert.equal(headProgramOf('Set-Location -PassThru C:\\repo; npm test', 'pwsh'), 'npm')
    assert.equal(headProgramOf('sl C:\\repo\nnpm test', 'pwsh'), 'npm')
    assert.equal(headProgramOf('cd C:\\repo', 'pwsh'), 'cd', 'a lone navigation stays the head')
    assert.equal(headProgramOf('cd ', 'pwsh'), 'cd')
    assert.equal(headProgramOf('cd C:\\repo;', 'pwsh'), 'cd')
    assert.equal(headProgramOf('& "$env:Foo\\$BAR"', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('& "$env:Foo`bar"', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('& "$env:Foo-bar"', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('& "$env:Foo.bar"', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('7z x file.7z', 'pwsh'), '7z', 'digit-leading names are programs')
    assert.equal(headProgramOf('7z.exe x', 'pwsh'), '7z')
    assert.equal(headProgramOf('2to3 -w x.py', 'pwsh'), '2to3')
    assert.equal(headProgramOf('-join ("a","b")', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('$x = 1 # use { here\nGet-Item x', 'pwsh'), 'Get-Item')
    assert.equal(headProgramOf('$x = 1 # comment', 'pwsh'), 'pwsh')
    assert.equal(headProgramOf('<# block #>\nGet-Item x', 'pwsh'), 'Get-Item')
    assert.equal(headProgramOf('<# block', 'pwsh'), 'pwsh')
  })

  test('programsOfCommand counts Bash invocations, repeats and scaffolding without reading literal text', () => {
    assert.deepEqual(programsOfCommand('grep -n foo a | grep -v bar && grep -c baz b'), ['grep', 'grep', 'grep'])
    assert.deepEqual(programsOfCommand('git status && git diff || git log; git status\ngit branch'), ['git', 'git', 'git', 'git', 'git'])
    assert.deepEqual(programsOfCommand('echo "grep | grep" # grep fake\ngrep real'), ['echo', 'grep'])
    assert.deepEqual(programsOfCommand("cat <<'EOF'\ngrep fake; grep fake\nEOF\ngrep real"), ['cat', 'grep'])
    assert.deepEqual(programsOfCommand('TOOL=git; $TOOL status && $TOOL diff'), ['git', 'git'])
    assert.deepEqual(programsOfCommand('cd /repo && git status && git diff'), ['git', 'git'])
    assert.deepEqual(programsOfCommand('[[ -f x ]] && pnpm test'), ['shell', 'pnpm'])
    assert.deepEqual(programsOfCommand('git status && FOO=bar'), ['git'])
    assert.deepEqual(programsOfCommand(''), [])
  })

  test('programsOfCommand counts PowerShell pipelines, call operators and literal assignments', () => {
    assert.deepEqual(
      programsOfCommand('Get-ChildItem | Select-Object Name; Get-ChildItem -File', 'pwsh'),
      ['Get-ChildItem', 'Select-Object', 'Get-ChildItem'],
    )
    assert.deepEqual(programsOfCommand('$exe = "git"; & $exe status; & $exe diff', 'pwsh'), ['git', 'git'])
    assert.deepEqual(
      programsOfCommand('& "C:\\Tools\\git.exe" status && & "C:\\Tools\\git.exe" diff', 'pwsh'),
      ['git', 'git'],
    )
    assert.deepEqual(programsOfCommand('"Get-Item | Select-Object"; Get-Item x', 'pwsh'), ['pwsh', 'Get-Item'])
    assert.deepEqual(programsOfCommand('', 'pwsh'), [])
  })

  test('programsOfCommand respects Bash escapes, nesting, redirections and navigation separators', () => {
    assert.deepEqual(programsOfCommand('echo a\\;b; echo c'), ['echo', 'echo'])
    assert.deepEqual(programsOfCommand('echo one & echo two |& cat'), ['echo', 'echo', 'cat'])
    assert.deepEqual(programsOfCommand('echo one 2>&1 | cat'), ['echo', 'cat'])
    assert.deepEqual(programsOfCommand('echo one &>log && cat'), ['echo', 'cat'])
    assert.deepEqual(programsOfCommand('(echo one; echo two) && cat'), ['shell', 'cat'])
    assert.deepEqual(programsOfCommand('{ echo one\necho two; } && cat'), ['shell', 'cat'])
    assert.deepEqual(programsOfCommand(') ; } ; echo'), ['shell', 'echo'])
    assert.deepEqual(programsOfCommand('echo "a\\";b"; cat'), ['echo', 'cat'])
    assert.deepEqual(programsOfCommand('# only'), ['shell'])
    assert.deepEqual(programsOfCommand(';;;'), ['shell'])
    assert.deepEqual(programsOfCommand('cd /x;'), ['cd'])
    assert.deepEqual(programsOfCommand('cd /x\ngit'), ['git'])
    assert.deepEqual(programsOfCommand('cd /x || git'), ['cd', 'git'])
  })

  test('programsOfCommand skips heredoc bodies, including indented CRLF and nested or partial forms', () => {
    assert.deepEqual(programsOfCommand('cat <<- \tEOF\r\n\tgrep fake\r\n\tEOF\r\ngrep real'), ['cat', 'grep'])
    assert.deepEqual(programsOfCommand('cat <<EOF\ngrep fake'), ['cat'])
    assert.deepEqual(programsOfCommand('cat <<\ngrep'), ['cat', 'grep'])
    assert.deepEqual(programsOfCommand('(cat <<EOF\nbody\nEOF\n) && grep'), ['shell', 'grep'])
  })

  test('programsOfCommand respects PowerShell escapes, comments, here-strings and navigation', () => {
    assert.deepEqual(programsOfCommand('Get-Item foo`; Write-Output', 'pwsh'), ['Get-Item'])
    assert.deepEqual(programsOfCommand('<# block; #>\nGet-Item', 'pwsh'), ['Get-Item'])
    assert.deepEqual(programsOfCommand('<# block', 'pwsh'), ['pwsh'])
    assert.deepEqual(programsOfCommand('$text = @"\nGet-Item; Get-Item\n"@\nGet-Item x', 'pwsh'), ['Get-Item'])
    assert.deepEqual(programsOfCommand("$text = @'\nGet-Item", 'pwsh'), ['pwsh'])
    assert.deepEqual(programsOfCommand("@'x'; Get-Item", 'pwsh'), ['pwsh', 'Get-Item'])
    assert.deepEqual(programsOfCommand('$x = "a`"b"; & $x; Get-Item', 'pwsh'), ['a"b', 'Get-Item'])
    assert.deepEqual(programsOfCommand("'a'';b'; Get-Item", 'pwsh'), ['pwsh', 'Get-Item'])
    assert.deepEqual(programsOfCommand('cd C:\\repo; Get-Item', 'pwsh'), ['Get-Item'])
    assert.deepEqual(programsOfCommand('Set-Location C:\\repo;', 'pwsh'), ['Set-Location'])
  })
})
})

describe('fileOps', () => {

function grepMeta(files: Record<string, number>): unknown {
  return {
    shape: 'matches',
    truncated: false,
    total: Object.values(files).reduce((a, b) => a + b, 0),
    files: Object.entries(files).map(([path, n]) => ({
      path,
      matches: Array.from({ length: n }, (_, i) => ({ line: i + 1, text: 'x' })),
    })),
  }
}

const at = (seq: number): number => 1_700_000_000_000 + seq

describe('opsOfCall — one op per settled call', () => {
  test('a read books its meta window, else its limit estimate; an unbounded read names no footprint', () => {
    const ops = opsOfCall({
      seq: 7, time: at(7), tool: 'read',
      argsRaw: JSON.stringify({ file_path: 'src/a.ts', offset: 10, limit: 50 }),
      meta: { path: 'src/a.ts', offset: 10, lines: [{ number: 10 }, { number: 11 }], totalLines: 99 },
    })
    assert.deepEqual(ops, [{
      seq: 7, time: at(7), tool: 'read', kind: 'read', err: false,
      added: 0, removed: 0, path: 'src/a.ts',
      read: { start: 10, count: 2 },
    }])
    const [est] = opsOfCall({ seq: 1, tool: 'read', argsRaw: JSON.stringify({ file_path: 'a.ts', limit: 12.9 }) })
    assert.deepEqual(est.read, { count: 12, est: true })
    const [unbounded] = opsOfCall({ seq: 1, tool: 'read', argsRaw: JSON.stringify({ file_path: 'a.ts' }) })
    assert.equal(unbounded.read, undefined)
    for (const meta of [
      { path: '', offset: 10, lines: [{}] },
      { path: 42, offset: 10, lines: [{}] },
      { path: 'a.ts', offset: 0, lines: [{}] },
      { path: 'a.ts', offset: 'x', lines: [{}] },
      { path: 'a.ts', offset: 1, lines: [] },
      { path: 'a.ts', offset: 1, lines: 'x' },
    ]) {
      const [fallback] = opsOfCall({ seq: 1, tool: 'read', argsRaw: JSON.stringify({ file_path: 'a.ts', limit: 5 }), meta })
      assert.deepEqual(fallback.read, { count: 5, est: true }, JSON.stringify(meta))
    }
  })

  test('an edit books the old/new line delta; a write books its content', () => {
    const [edit] = opsOfCall({
      seq: 1, tool: 'edit',
      argsRaw: JSON.stringify({ file_path: 'a.ts', old_string: 'x\ny', new_string: 'z' }),
    })
    assert.deepEqual([edit.added, edit.removed], [1, 2])
    const [write] = opsOfCall({ seq: 2, tool: 'write', argsRaw: JSON.stringify({ file_path: 'b.ts', content: 'a\nb\n' }) })
    assert.deepEqual([write.added, write.removed], [2, 0])
    assert.equal(write.kind, 'write')
  })

  test('str_replace_editor: view reads, the other commands write their shapes', () => {
    const [view] = opsOfCall({ seq: 1, tool: 'str_replace_editor', argsRaw: JSON.stringify({ command: 'view', path: '/a.ts' }) })
    assert.equal(view.kind, 'read')
    const [rep] = opsOfCall({ seq: 2, tool: 'str_replace_editor', argsRaw: JSON.stringify({ command: 'str_replace', path: '/a.ts', old_str: 'x', new_str: 'y\nz' }) })
    assert.deepEqual([rep.kind, rep.added, rep.removed], ['write', 2, 1])
    const [ins] = opsOfCall({ seq: 3, tool: 'str_replace_editor', argsRaw: JSON.stringify({ command: 'insert', path: '/a.ts', new_str: 'q' }) })
    assert.deepEqual([ins.added, ins.removed], [1, 0])
    const [create] = opsOfCall({ seq: 4, tool: 'str_replace_editor', argsRaw: JSON.stringify({ command: 'create', path: '/a.ts', file_text: 'q' }) })
    assert.deepEqual([create.added, create.removed], [1, 0])
    const [odd] = opsOfCall({ seq: 5, tool: 'str_replace_editor', argsRaw: JSON.stringify({ command: 'undo_edit', path: '/a.ts' }), err: true })
    assert.deepEqual([odd.kind, odd.added, odd.removed, odd.err], ['write', 0, 0, true])
  })

  test('a search target rows as the path with the pattern detail, or as the pattern itself when pathless', () => {
    const [op] = opsOfCall({
      seq: 3, tool: 'grep',
      argsRaw: JSON.stringify({ pattern: 'TODO', path: 'src/', include: '*.ts' }),
    })
    assert.deepEqual([op.kind, op.path, op.detail, op.pattern], ['search', 'src/', 'TODO (*.ts)', undefined])
    const [pathless] = opsOfCall({ seq: 1, tool: 'glob', argsRaw: JSON.stringify({ pattern: '**/*.md' }) })
    assert.deepEqual([pathless.path, pathless.pattern, pathless.detail], ['**/*.md', true, undefined])
  })

  test('the complete matches and paths meta attribute the target AND one op per hit', () => {
    const matches = opsOfCall({
      seq: 5, tool: 'grep',
      argsRaw: JSON.stringify({ pattern: 'TODO' }),
      meta: grepMeta({ 'a.ts': 3, 'b.ts': 1 }),
    })
    assert.deepEqual(matches.map(o => [o.path, o.hits]), [['TODO', undefined], ['a.ts', 3], ['b.ts', 1]])
    assert.equal(matches[0].pattern, true, 'the pathless target rows as the pattern')
    assert.ok(matches.slice(1).every(o => o.detail === 'TODO'), 'the pattern detail rides each hit op')
    assert.ok(matches.slice(1).every(o => o.pattern === undefined))
    const paths = opsOfCall({
      seq: 1, tool: 'glob',
      argsRaw: JSON.stringify({ pattern: '*.ts' }),
      meta: { shape: 'paths', truncated: false, total: 2, paths: ['a.ts', 'b.ts'] },
    })
    assert.deepEqual(paths.map(o => o.path), ['*.ts', 'a.ts', 'b.ts'])
    assert.ok(paths.every(o => o.hits === undefined))
    const junkPaths = opsOfCall({
      seq: 1, tool: 'glob',
      argsRaw: JSON.stringify({ pattern: '*.ts' }),
      meta: { shape: 'paths', truncated: false, total: 3, paths: ['a.ts', 42, ''] },
    })
    assert.deepEqual(junkPaths.map(o => o.path), ['*.ts', 'a.ts'], 'non-string and empty paths drop')
    const missingPaths = opsOfCall({
      seq: 1, tool: 'glob',
      argsRaw: JSON.stringify({ pattern: '*.ts' }),
      meta: { shape: 'paths', truncated: false, total: 0 },
    })
    assert.deepEqual(missingPaths.map(o => o.path), ['*.ts'], 'no paths list falls back to the target')
  })

  test('a narrowed search rows the searched directory AND each hit file', () => {
    const ops = opsOfCall({
      seq: 1, tool: 'grep',
      argsRaw: JSON.stringify({ pattern: 'TODO', path: 'src/', include: '*.ts' }),
      meta: grepMeta({ 'src/a.ts': 2, 'src/b.ts': 1 }),
    })
    assert.deepEqual(ops.map(o => [o.path, o.hits ?? 0]), [['src/', 0], ['src/a.ts', 2], ['src/b.ts', 1]])
    assert.equal(ops[0].detail, 'TODO (*.ts)')
    assert.equal(ops[0].pattern, undefined, 'a real path is not a pattern row')
  })

  test('a single-file search does not double-row the target (it IS the matched file)', () => {
    const ops = opsOfCall({
      seq: 1, tool: 'grep',
      argsRaw: JSON.stringify({ pattern: 'TODO', path: 'src/a.ts' }),
      meta: grepMeta({ 'src/a.ts': 2 }),
    })
    assert.deepEqual(ops.map(o => o.path), ['src/a.ts'], 'one row, with its hit count')
    assert.equal(ops[0].hits, 2)
    assert.equal(ops[0].detail, 'TODO')
  })

  test('a truncated or malformed meta falls back to the call target', () => {
    const capped = opsOfCall({
      seq: 1, tool: 'grep',
      argsRaw: JSON.stringify({ pattern: 'TODO', path: 'src/' }),
      meta: { shape: 'matches', truncated: true, files: [{ path: 'a.ts', matches: [{}] }] },
    })
    assert.deepEqual(capped.map(o => o.path), ['src/'])
    const junk = opsOfCall({
      seq: 1, tool: 'grep',
      argsRaw: JSON.stringify({ pattern: 'TODO', path: 'src/' }),
      meta: { shape: 'matches', truncated: false, files: [{ path: 42 }, null] },
    })
    assert.deepEqual(junk.map(o => o.path), ['src/'], 'a meta whose entries are all junk falls back')
    const empty = opsOfCall({
      seq: 1, tool: 'glob',
      argsRaw: JSON.stringify({ pattern: '*.ts', path: 'src/' }),
      meta: { shape: 'paths', truncated: false, total: 0, paths: [] },
    })
    assert.deepEqual(empty.map(o => o.path), ['src/'])
  })

  test('the meta attribution works even when the call arguments failed to parse', () => {
    const ops = opsOfCall({ seq: 1, tool: 'grep', argsRaw: '{broken', meta: grepMeta({ 'a.ts': 2 }) })
    assert.deepEqual(ops.map(o => [o.path, o.hits]), [['a.ts', 2]])
    assert.ok(ops.every(o => o.detail === undefined), 'no parsed args — no detail line')
  })

  test('zero-ops degradations: non-file tools, unparseable args, and pathless targets', () => {
    assert.deepEqual(opsOfCall({ seq: 1, tool: 'bash', argsRaw: JSON.stringify({ command: 'ls' }) }), [])
    assert.deepEqual(opsOfCall({ seq: 1, tool: 'read', argsRaw: 'not json' }), [])
    assert.deepEqual(opsOfCall({ seq: 1, tool: 'read', argsRaw: JSON.stringify({ no_path: true }) }), [])
    assert.deepEqual(opsOfCall({ seq: 1, tool: 'read', argsRaw: JSON.stringify(['not-a-record']) }), [])
    assert.deepEqual(opsOfCall({ seq: 1, tool: 'str_replace_editor' }), [], 'no args at all: the editor writes nothing listable')
  })

  test('the stamps ride along: err/time/gone/parent/program', () => {
    const [op] = opsOfCall({
      seq: 9, time: at(9), tool: 'write',
      argsRaw: JSON.stringify({ file_path: 'a.ts', content: 'x' }),
      err: true, gone: 40, parent: 33, program: 'fix the bug',
    })
    assert.deepEqual([op.err, op.time, op.gone, op.parent, op.program], [true, at(9), 40, 33, 'fix the bug'])
  })
})

describe('parseCallArgs', () => {
  test('parses raw JSON records; everything else is null', () => {
    assert.deepEqual(parseCallArgs('{"a":1}'), { a: 1 })
    assert.equal(parseCallArgs('[1]'), null)
    assert.equal(parseCallArgs('"s"'), null)
    assert.equal(parseCallArgs('{broken'), null)
    assert.equal(parseCallArgs(''), null)
    assert.equal(parseCallArgs(undefined), null)
    assert.equal(parseCallArgs(42), null)
    assert.equal(parseCallArgs(null), null)
  })
})
})
