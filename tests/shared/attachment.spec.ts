import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { attachmentExtension, attachmentOf, attachmentsIn, isImageName, leafNameOf } from '../../src/shared/attachment'
import { dayKeyOf, endOfDayKey, monthGridOf, shiftDayKey, shiftMonthKey, startOfDayKey, sundayOfWeek, weekdayOf } from '../../src/shared/days'
import { amountOf, asPlainObject, asRecord, stringOf } from '../../src/shared/decode'
import { estimateSystemContent, estimateSystemTokens } from '../../src/shared/estimate'
import { estimateFileTokens } from '../../src/shared/fileTokens'
import { estimateImageTokens } from '../../src/shared/imageTokens'
import { readFile } from 'node:fs/promises'
import { DEFAULT_RECOM, RECOM_REPOSITORY_ROOT, recomOf, recomsOfPayload } from '../../src/shared/recoms'
import { meetsBaseline, parseVersion } from '../../src/shared/version'

describe('attachment', () => {

describe('attachmentExtension', () => {
  test('reads the last suffix of a name or path, lower-cased; a missing or trailing suffix is empty', () => {
    assert.equal(attachmentExtension('report.MD'), 'md')
    assert.equal(attachmentExtension('dir/sub/file.tar.gz'), 'gz')
    assert.equal(attachmentExtension('C:\\docs\\sheet.XLSX'), 'xlsx')
    assert.equal(attachmentExtension('README'), '')
    assert.equal(attachmentExtension('archive.'), '')
    assert.equal(attachmentExtension('.env'), 'env')
    assert.equal(attachmentExtension(''), '')
  })
})

describe('isImageName', () => {
  test('matches exactly the suffixes the preview column\'s image viewers claim', () => {
    assert.equal(isImageName('x.PNG'), true)
    assert.equal(isImageName('/dir/shot.webp'), true)
    assert.equal(isImageName('vector.svg'), true)
    assert.equal(isImageName('scan.tiff'), false, 'the column lists tiff as unviewable')
    assert.equal(isImageName('photo.avif'), false, 'the column lists avif as unviewable')
    assert.equal(isImageName('notes.md'), false)
    assert.equal(isImageName('report.docx'), false)
    assert.equal(isImageName(''), false)
  })
})

describe('leafNameOf', () => {
  test('keeps the leaf of either separator style, so a path never escapes its directory', () => {
    assert.equal(leafNameOf('/a/b/report.md'), 'report.md')
    assert.equal(leafNameOf('C:\\tmp\\x.png'), 'x.png')
    assert.equal(leafNameOf('report.md'), 'report.md')
    assert.equal(leafNameOf(''), '')
  })
})

describe('attachmentOf', () => {
  test('rejects every non-attachment block and a missing or malformed envelope', () => {
    assert.equal(attachmentOf(null), null)
    assert.equal(attachmentOf('image'), null)
    assert.equal(attachmentOf(42), null)
    assert.equal(attachmentOf({}), null)
    assert.equal(attachmentOf({ type: 'text', attachment: { attachmentId: 'a' } }), null)
    assert.equal(attachmentOf({ kind: 'mystery', attachment: { attachmentId: 'a' } }), null)
    assert.equal(attachmentOf({ type: 'image' }), null)
    assert.equal(attachmentOf({ type: 'image', attachment: null }), null)
    assert.equal(attachmentOf({ type: 'image', attachment: 'x' }), null)
    assert.equal(attachmentOf({ type: 'file', attachment: {} }), null)
    assert.equal(attachmentOf({ type: 'file', attachment: { attachmentId: '' } }), null)
    assert.equal(attachmentOf({ type: 'file', attachment: { attachmentId: 42 } }), null)
  })

  test('a verbatim file keeps the name and size the log carries', () => {
    assert.deepEqual(
      attachmentOf({ type: 'file', attachment: { attachmentId: 'sha256:x', name: 'notes.md', bytes: 47320 } }),
      { kind: 'file', attachmentId: 'sha256:x', name: 'notes.md', bytes: 47320 },
    )
    assert.deepEqual(attachmentOf({ kind: 'file', attachment: { attachmentId: 'sha256:x' } }), { kind: 'file', attachmentId: 'sha256:x' })
    assert.deepEqual(
      attachmentOf({ type: 'file', attachment: { attachmentId: 'sha256:x', name: '', bytes: -1 } }),
      { kind: 'file', attachmentId: 'sha256:x' },
    )
  })

  test('an image passes every proven fact and drops the hostile ones', () => {
    assert.deepEqual(
      attachmentOf({
        type: 'image',
        attachment: {
          attachmentId: 'sha256:i',
          mediaType: 'image/jpeg',
          name: 'result-image-1.jpg',
          bytes: 146227,
          width: 1568,
          height: 1350,
          originalDimensions: { width: 3462, height: 1211 },
        },
      }),
      {
        kind: 'image',
        attachmentId: 'sha256:i',
        name: 'result-image-1.jpg',
        mediaType: 'image/jpeg',
        bytes: 146227,
        width: 1568,
        height: 1350,
        originalDimensions: { width: 3462, height: 1211 },
      },
    )
    assert.deepEqual(
      attachmentOf({
        kind: 'image',
        attachment: {
          attachmentId: 'sha256:i',
          mediaType: '',
          name: '',
          bytes: '500',
          width: NaN,
          height: 0,
          originalDimensions: 'big',
        },
      }),
      { kind: 'image', attachmentId: 'sha256:i' },
    )
    assert.deepEqual(
      attachmentOf({ type: 'image', attachment: { attachmentId: 'sha256:i', originalDimensions: null } }),
      { kind: 'image', attachmentId: 'sha256:i' },
    )
    assert.deepEqual(
      attachmentOf({ type: 'image', attachment: { attachmentId: 'sha256:i', originalDimensions: { width: 0, height: 10 } } }),
      { kind: 'image', attachmentId: 'sha256:i' },
    )
    assert.deepEqual(
      attachmentOf({ type: 'image', attachment: { attachmentId: 'sha256:i', originalDimensions: { width: 4000, height: 3000 } } }),
      { kind: 'image', attachmentId: 'sha256:i', originalDimensions: { width: 4000, height: 3000 } },
    )
  })
})

describe('attachmentsIn', () => {
  test('keeps the message order and drops everything else; a non-array content has none', () => {
    const content = [
      { type: 'file', attachment: { attachmentId: 'f1', name: 'a.svg', bytes: 2627 } },
      { type: 'text', text: 'hello' },
      { type: 'image', attachment: { attachmentId: 'i1', width: 10, height: 10 } },
      null,
      'plain',
      { type: 'file' },
    ]
    assert.deepEqual(attachmentsIn(content), [
      { kind: 'file', attachmentId: 'f1', name: 'a.svg', bytes: 2627 },
      { kind: 'image', attachmentId: 'i1', width: 10, height: 10 },
    ])
    assert.deepEqual(attachmentsIn(undefined), [])
    assert.deepEqual(attachmentsIn('content'), [])
  })
})
})

describe('days', () => {

describe('dayKeyOf', () => {
  test('keys a local instant as YYYY-MM-DD with zero padding, midnight to the new day', () => {
    assert.equal(dayKeyOf(new Date(2026, 8, 16, 12).getTime()), '2026-09-16')
    assert.equal(dayKeyOf(new Date(2026, 0, 5, 12).getTime()), '2026-01-05')
    assert.equal(dayKeyOf(new Date(2026, 11, 25, 12).getTime()), '2026-12-25')
    assert.equal(dayKeyOf(new Date(2026, 0, 2, 0, 0, 0).getTime()), '2026-01-02')
  })

  test('non-finite and out-of-range instants key null', () => {
    assert.equal(dayKeyOf(Number.NaN), null)
    assert.equal(dayKeyOf(Number.POSITIVE_INFINITY), null)
    assert.equal(dayKeyOf(1e30), null, 'outside the representable date range')
    assert.equal(dayKeyOf(-2 * 86_400_000), null, 'before the epoch in every timezone')
    assert.equal(dayKeyOf(new Date(10000, 0, 1).getTime()), null, 'past the four-digit year')
  })
})

describe('shiftDayKey', () => {
  test('advances and retreats across month and year boundaries', () => {
    assert.equal(shiftDayKey('2026-09-16', 1), '2026-09-17')
    assert.equal(shiftDayKey('2026-09-16', -1), '2026-09-15')
    assert.equal(shiftDayKey('2026-01-31', 1), '2026-02-01')
    assert.equal(shiftDayKey('2026-03-01', -1), '2026-02-28')
    assert.equal(shiftDayKey('2027-01-01', -1), '2026-12-31')
    assert.equal(shiftDayKey('2024-02-28', 1), '2024-02-29', 'leap day kept')
  })

  test('malformed keys yield null instead of a rolled-over date', () => {
    assert.equal(shiftDayKey('garbage', 1), null)
    assert.equal(shiftDayKey('2026-13-01', 1), null, 'month 13 would roll over')
    assert.equal(shiftDayKey('2026-02-30', 1), null, 'February 30th does not exist')
    assert.equal(shiftDayKey('2026-9-6', 1), null, 'unpadded fields fail the shape')
  })
})

describe('sundayOfWeek', () => {
  test('every weekday maps to its week’s Sunday (2026-09-13 was one)', () => {
    assert.equal(sundayOfWeek('2026-09-13'), '2026-09-13', 'Sunday itself')
    assert.equal(sundayOfWeek('2026-09-16'), '2026-09-13', 'Wednesday')
    assert.equal(sundayOfWeek('2026-09-19'), '2026-09-13', 'Saturday belongs to the same Sunday-first week')
    assert.equal(sundayOfWeek('2026-09-20'), '2026-09-20', 'the next week starts Sunday')
  })

  test('malformed keys yield null', () => {
    assert.equal(sundayOfWeek('junk'), null)
    assert.equal(sundayOfWeek('2026-02-30'), null)
  })
})

describe('startOfDayKey / endOfDayKey', () => {
  test('a picked range spans the whole local day; malformed keys yield null', () => {
    assert.equal(startOfDayKey('2026-09-16'), new Date(2026, 8, 16, 0, 0, 0, 0).getTime())
    assert.equal(endOfDayKey('2026-09-16'), new Date(2026, 8, 16, 23, 59, 59, 999).getTime())
    assert.equal(startOfDayKey('2026-03-08'), new Date(2026, 2, 8, 0, 0, 0, 0).getTime(), 'a DST-short day still opens on its own midnight')
    assert.equal(startOfDayKey('2026-02-30'), null)
    assert.equal(endOfDayKey('nope'), null)
  })
})

describe('shiftMonthKey', () => {
  test('steps across month and year boundaries', () => {
    assert.equal(shiftMonthKey('2026-10', 1), '2026-11')
    assert.equal(shiftMonthKey('2026-10', -1), '2026-09')
    assert.equal(shiftMonthKey('2026-12', 1), '2027-01')
    assert.equal(shiftMonthKey('2026-01', -1), '2025-12')
    assert.equal(shiftMonthKey('2026-10', 14), '2027-12')
  })

  test('malformed keys and out-of-range targets yield null', () => {
    assert.equal(shiftMonthKey('2026-13', 1), null)
    assert.equal(shiftMonthKey('2026-00', 1), null)
    assert.equal(shiftMonthKey('2026-1', 1), null)
    assert.equal(shiftMonthKey('junk', 1), null)
    assert.equal(shiftMonthKey('1970-01', -1), null, 'before the representable range')
    assert.equal(shiftMonthKey('9999-12', 1), null, 'past the representable range')
  })
})

describe('weekdayOf', () => {
  test('returns the local weekday index, 0 = Sunday', () => {
    assert.equal(weekdayOf('2026-09-13'), 0)
    assert.equal(weekdayOf('2026-09-16'), 3)
    assert.equal(weekdayOf('2026-09-19'), 6)
    assert.equal(weekdayOf('2026-02-30'), null)
  })
})

describe('monthGridOf', () => {
  test('lays a month out as Sunday-first weeks of seven cells; a Sunday opening needs no lead blank', () => {
    const grid = monthGridOf('2026-09')
    assert.ok(grid !== null)
    assert.equal(grid[0].length, 7)
    assert.deepEqual(grid[0].slice(0, 3), [null, null, '2026-09-01'])
    assert.equal(grid[0][6], '2026-09-05')
    const last = grid[grid.length - 1]
    assert.deepEqual(last.filter((k) => k !== null), ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30'], 'the open week is padded, never half-filled')
    const days = grid.flat().filter((k) => k !== null)
    assert.equal(days.length, 30)
    assert.equal(days.every((k) => k.startsWith('2026-09')), true)
    const nov = monthGridOf('2026-11')
    assert.ok(nov !== null)
    assert.equal(nov[0][0], '2026-11-01')
    assert.equal(nov[0].filter((k) => k !== null).length, 7)
  })

  test('malformed months and a month that leaves the key range yield null', () => {
    assert.equal(monthGridOf('2026-13'), null)
    assert.equal(monthGridOf('junk'), null)
    assert.ok(monthGridOf('9999-12') !== null)
  })
})
})

describe('decode', () => {

describe('asRecord', () => {
  test('keeps any object, arrays included; every non-object is null', () => {
    const value = { a: 1 }
    assert.equal(asRecord(value), value)
    const list: unknown[] = [1, 2]
    assert.equal(asRecord(list), list, 'the client-side guard keeps arrays for callers that read own fields')
    for (const absent of [null, undefined, 'text', 42, true]) assert.equal(asRecord(absent), null)
    assert.equal(asRecord(() => 0), null)
  })
})

describe('asPlainObject', () => {
  test('rejects arrays and every non-object; a plain object passes through', () => {
    const value = { a: 1 }
    assert.equal(asPlainObject(value), value)
    for (const rejected of [null, undefined, 'text', 42, true, [1, 2]]) assert.equal(asPlainObject(rejected), null)
    assert.equal(asPlainObject(() => 0), null)
  })
})

describe('amountOf', () => {
  test('normalizes a finite non-negative number or numeric string; everything else is null', () => {
    assert.equal(amountOf(0), 0)
    assert.equal(amountOf(12.5), 12.5)
    assert.equal(amountOf('12.5'), 12.5)
    assert.equal(amountOf('-1'), null)
    assert.equal(amountOf(-1), null)
    assert.equal(amountOf('abc'), null)
    assert.equal(amountOf(''), 0, 'Number(empty) is zero, the pre-existing wire guard behavior')
    assert.equal(amountOf(Number.NaN), null)
    assert.equal(amountOf(Number.POSITIVE_INFINITY), null)
    for (const rejected of [null, undefined, true, {}, []]) assert.equal(amountOf(rejected), null)
  })
})

describe('stringOf', () => {
  test('keeps a non-empty string and drops the rest', () => {
    assert.equal(stringOf('value'), 'value')
    assert.equal(stringOf(' '), ' ')
    assert.equal(stringOf(''), undefined)
    for (const rejected of [null, undefined, 0, 42, true, {}]) assert.equal(stringOf(rejected), undefined)
  })
})
})

describe('estimate', () => {

describe('estimateSystemTokens', () => {
  test('prices text density plus role framing', () => {
    assert.equal(estimateSystemTokens('abcdefgh'), 2 + 4)
    assert.equal(estimateSystemTokens('abcde'), 2 + 4, 'partial tokens round up')
  })

  test('absent, empty, and non-string input prices 0', () => {
    assert.equal(estimateSystemTokens(undefined), 0)
    assert.equal(estimateSystemTokens(null), 0)
    assert.equal(estimateSystemTokens(''), 0)
    assert.equal(estimateSystemTokens(42), 0)
    assert.equal(estimateSystemTokens({ text: 'x' }), 0)
  })
})

describe('estimateSystemContent', () => {
  test('prices every text block with no per-block overhead; no content prices 0', () => {
    assert.equal(estimateSystemContent([{ type: 'text', text: 'abcdefgh' }]), 2 + 4)
    assert.equal(
      estimateSystemContent([{ type: 'text', text: 'abcd' }, { type: 'text', text: 'efgh' }]),
      2 + 4,
      'blocks are summed before the density divide, exactly like the harness estimator',
    )
    assert.equal(estimateSystemContent([]), 0)
    assert.equal(estimateSystemContent(undefined), 0)
    assert.equal(estimateSystemContent('text'), 0)
  })

  test('a non-text element falls back to its JSON length; hostile elements degrade instead of throwing', () => {
    const block = { type: 'image', attachment: { width: 1, height: 1 } }
    assert.equal(estimateSystemContent([block]), Math.ceil(JSON.stringify(block).length / 4) + 4)
    assert.equal(estimateSystemContent([7]), Math.ceil('7'.length / 4) + 4)
    assert.equal(estimateSystemContent([undefined]), 0 + 4)
    assert.equal(estimateSystemContent([{ type: 'text', text: 42 }]), Math.ceil('{"type":"text","text":42}'.length / 4) + 4)
    const cyclic: Record<string, unknown> = { type: 'weird' }
    cyclic.self = cyclic
    assert.equal(estimateSystemContent([cyclic]), 4, 'role framing survives, content prices 0')
  })
})
})

describe('fileTokens', () => {

const DIGEST = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

function file(over: { name?: string; bytes?: number; attachmentId?: string } = {}) {
  return { attachmentId: DIGEST, name: 'notes.md', bytes: 120, ...over }
}

describe('estimateFileTokens', () => {
  test('the price is the harness handle priced as one text block', () => {
    const handle = '[File "notes.md" (120 bytes, sha256:01234567) was uploaded, but the current execution'
      + ' environment cannot access a readable path. Report that limitation if its contents are needed;'
      + ' do not claim to have read it.]'
    assert.equal(estimateFileTokens(file()), Math.ceil(handle.length / 4) + 4)
    assert.equal(estimateFileTokens(file({ bytes: 778_285 })), 58, 'only the name and digest prefix reach the handle')
    assert.equal(estimateFileTokens(file({ attachmentId: `sha256:${'f'.repeat(64)}` })), 57)
  })

  test('a name or a byte size the log does not prove prices nothing', () => {
    assert.equal(estimateFileTokens(file({ name: undefined })), null)
    assert.equal(estimateFileTokens(file({ bytes: undefined })), null)
  })
})
})

describe('imageTokens', () => {

describe('estimateImageTokens', () => {
  test('prices the published v41 reference sizes', () => {
    for (const [width, height, expected] of [
      [100, 100, 184],
      [544, 544, 184],
      [640, 480, 206],
      [800, 800, 422],
      [1024, 768, 496],
      [1066, 600, 407],
      [1300, 1300, 994],
      [1920, 1080, 968],
      [2000, 2000, 994],
      [5000, 5000, 994],
      [300, 50, 200],
      [8192, 100, 593],
      [16, 8192, 590],
    ] as const) {
      assert.equal(estimateImageTokens(width, height), expected, `${width}x${height}`)
    }
  })

  test('caps every image at 1024 tokens', () => {
    for (const [width, height] of [[2000, 2000], [5000, 5000], [8192, 8192], [16, 8192], [9000, 1], [1, 9000]] as const) {
      const tokens = estimateImageTokens(width, height)
      assert.ok(tokens !== null && tokens <= 1024, `${width}x${height} -> ${tokens}`)
    }
  })

  test('prices small images at the documented scale-up floor', () => {
    assert.equal(estimateImageTokens(100, 100), estimateImageTokens(544, 544))
  })

  test('solves a one-row grid for an extremely wide image', () => {
    assert.equal(estimateImageTokens(9000, 1), 1024)
  })

  test('solves a one-column grid for an extremely tall image', () => {
    assert.equal(estimateImageTokens(1, 9000), 1024)
  })

  test('converges through repeated projection passes when the first is not a fixpoint', () => {
    assert.equal(estimateImageTokens(12, 1123), 380)
    assert.equal(estimateImageTokens(89, 2076), 254)
  })

  test('non-positive or non-finite dimensions return null', () => {
    assert.equal(estimateImageTokens(0, 100), null)
    assert.equal(estimateImageTokens(100, 0), null)
    assert.equal(estimateImageTokens(-5, 100), null)
    assert.equal(estimateImageTokens(100, -5), null)
    assert.equal(estimateImageTokens(NaN, 100), null)
    assert.equal(estimateImageTokens(100, Infinity), null)
  })

  test('every valid size lands inside the documented cap band', () => {
    for (let width = 16; width <= 4096; width *= 2) {
      for (let height = 16; height <= 4096; height *= 2) {
        const tokens = estimateImageTokens(width, height)
        assert.ok(tokens !== null && tokens >= 2 && tokens <= 1024, `${width}x${height} -> ${tokens}`)
      }
    }
  })

  test('prices subnormal dimensions as the published calculator does', () => {
    assert.equal(estimateImageTokens(1e-300, 1e-300), 2)
  })
})
})

describe('recoms', () => {

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'example',
    name: 'Example',
    url: 'https://example.com',
    icon: 'docs/recoms/deepseek.svg',
    slogan: { en: 'Slogan', zh: '标语' },
    promotion: { en: 'Promo', zh: '推广' },
    tooltip: { en: 'Tip', zh: '说明' },
    ...over,
  }
}

describe('recom payload', () => {
  test('the repository data keeps the built-in DeepSeek fallback and drops no sponsor entry', async () => {
    const source = await readFile(new URL('../../data/recoms.json', import.meta.url), 'utf8')
    const payload = JSON.parse(source) as { id: string }[]
    const rows = recomsOfPayload(payload)
    assert.equal(rows.length, payload.length)
    assert.deepEqual(rows[0], DEFAULT_RECOM)
    assert.deepEqual(rows.map((row) => row.id), payload.map((item) => item.id))
  })

  test('relative icons resolve against the repository root and absolute links keep their form', () => {
    assert.equal(recomOf(entry())?.icon, RECOM_REPOSITORY_ROOT + 'docs/recoms/deepseek.svg')
    assert.equal(recomOf(entry({ icon: 'https://simpleicons.org/icons/deepseek.svg' }))?.icon, 'https://simpleicons.org/icons/deepseek.svg')
    assert.equal(recomOf(entry({ url: 'https://example.com/' }))?.url, 'https://example.com/')
  })

  test('non-list payloads and invalid entries are rejected without sacrificing valid siblings', () => {
    for (const value of [null, {}, 'list', 42]) assert.deepEqual(recomsOfPayload(value), [])
    const hostile = new Proxy({}, { get() { throw new Error('hostile') } })
    const rows = recomsOfPayload([null, 'bad', hostile, entry()])
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.id, 'example')
    assert.equal(recomsOfPayload([entry({ id: '' })]).length, 0)
  })

  test('identity, link, icon, and localized text guards reject every malformed shape', () => {
    for (const value of [null, [], 'row']) assert.equal(recomOf(value), null)
    const invalid: unknown[] = [
      entry({ id: 7 }), entry({ id: ' ' }), entry({ name: 7 }), entry({ name: '' }),
      entry({ url: 7 }), entry({ url: 'not a url' }), entry({ url: 'http://example.com' }),
      entry({ icon: 7 }), entry({ icon: '' }), entry({ icon: 'http://[' }),
      entry({ icon: 'http://evil.test/icon.svg' }), entry({ icon: 'data:image/svg+xml,x' }),
      entry({ slogan: null }), entry({ slogan: [] }), entry({ slogan: { en: 7, zh: '标语' } }),
      entry({ slogan: { en: '', zh: '标语' } }), entry({ slogan: { en: 'Slogan', zh: 7 } }),
      entry({ slogan: { en: 'Slogan', zh: ' ' } }), entry({ promotion: { en: '', zh: '推广' } }),
      entry({ tooltip: { en: 'Tip', zh: '' } }),
    ]
    for (const value of invalid) assert.equal(recomOf(value), null)
  })
})
})

describe('version', () => {

describe('parseVersion', () => {
  test('parses plain releases, channels, serials, v-prefixes and build metadata', () => {
    assert.deepEqual(parseVersion('0.1.2-rc.1'), { major: 0, minor: 1, patch: 2, rank: 3, serial: 1 })
    assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, rank: 4, serial: 0 })
    assert.deepEqual(parseVersion('v2.0.0-alpha'), { major: 2, minor: 0, patch: 0, rank: 1, serial: 0 })
    assert.deepEqual(parseVersion('0.1.2-beta.3'), { major: 0, minor: 1, patch: 2, rank: 2, serial: 3 })
    assert.deepEqual(parseVersion(' 0.1.2-RC.2 '), { major: 0, minor: 1, patch: 2, rank: 3, serial: 2 })
    assert.deepEqual(parseVersion('1.0.0+build.5'), { major: 1, minor: 0, patch: 0, rank: 4, serial: 0 })
  })

  test('rejects non-semver strings', () => {
    for (const bad of ['', 'abc', '1.2', '1.2.3.4', '1.2.3-nightly', '1.2.3-rc.x', '0.0.0-dev', 'v1.2.3.4-something']) {
      assert.equal(parseVersion(bad), null, bad)
    }
  })
})

describe('meetsBaseline', () => {
  test('baseline and above pass; anything below fails', () => {
    assert.equal(meetsBaseline('0.2.0-rc.2'), true, 'the baseline itself')
    assert.equal(meetsBaseline('0.2.0-rc.3'), true)
    assert.equal(meetsBaseline('0.2.0'), true, 'the final release of the baseline line')
    assert.equal(meetsBaseline('0.2.1-rc.2'), true, 'the newer supported line')
    assert.equal(meetsBaseline('0.2.1-alpha.1'), true, 'a semantically newer release at a lower channel outranks the floor')
    assert.equal(meetsBaseline('1.0.0-alpha.1'), true, 'a newer major outranks everything below it')
    assert.equal(meetsBaseline('0.2.0-rc.1'), false, 'an older rc of the baseline line')
    assert.equal(meetsBaseline('0.2.0-alpha.1'), false, 'alpha is below rc at equal X.Y.Z')
    assert.equal(meetsBaseline('0.1.7-rc.2'), false, 'the just-dropped line is now below the floor')
    assert.equal(meetsBaseline('0.1.7'), false, 'the dropped line final')
    assert.equal(meetsBaseline('0.3.0-alpha.1'), true, 'a newer minor at a lower channel outranks the floor')
    assert.equal(meetsBaseline('0.0.9'), false)
  })

  test('fails open: an unparseable version (or baseline) never gates, and an explicit baseline is honoured', () => {
    assert.equal(meetsBaseline('0.0.0-dev'), true)
    assert.equal(meetsBaseline('not-a-version'), true)
    assert.equal(meetsBaseline('0.1.0', 'also-junk'), true)
    assert.equal(meetsBaseline('0.1.7-rc.2', '0.2.0'), false)
    assert.equal(meetsBaseline('0.2.0', '0.2.0-alpha.1'), true)
  })
})
})
