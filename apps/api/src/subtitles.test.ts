import { describe, expect, test } from 'bun:test'
import { dualSubtitleVtt } from './subtitles'

const source = [
  { seq: 0, startMs: 0, endMs: 2_000, text: 'People who got rich by accident.' },
  { seq: 1, startMs: 2_000, endMs: 4_000, text: 'It happens more than you think.' },
]

describe('dualSubtitleVtt', () => {
  test('puts the spoken line above its translation', () => {
    const body = dualSubtitleVtt({
      sourceSegments: source,
      segments: [
        { seq: 0, startMs: 0, endMs: 2_000, text: '우연히 부자가 된 사람들.' },
        { seq: 1, startMs: 2_000, endMs: 4_000, text: '생각보다 흔한 일이다.' },
      ],
    })

    expect(body).toBe(
      [
        'WEBVTT',
        '',
        '1',
        '00:00:00.000 --> 00:00:02.000',
        'People who got rich by accident.',
        '우연히 부자가 된 사람들.',
        '',
        '2',
        '00:00:02.000 --> 00:00:04.000',
        'It happens more than you think.',
        '생각보다 흔한 일이다.',
        '',
      ].join('\n'),
    )
  })

  test('holds a cue until the next line starts', () => {
    const body = dualSubtitleVtt({
      sourceSegments: [{ seq: 0, startMs: 0, endMs: 2_000, text: 'Hello.' }],
      segments: [
        { seq: 0, startMs: 0, endMs: 2_000, text: '안녕.' },
        { seq: 1, startMs: 3_000, endMs: 4_000, text: '잘 가.' },
      ],
    })
    expect(body).toContain('00:00:00.000 --> 00:00:03.000')
  })

  test('keeps a translation whose source row is missing', () => {
    const body = dualSubtitleVtt({
      sourceSegments: [],
      segments: [{ seq: 7, startMs: 0, endMs: 1_000, text: '번역만 있다.' }],
    })
    expect(body).toContain('1\n00:00:00.000 --> 00:00:01.000\n번역만 있다.\n')
  })

  test('drops an empty translation and joins the gap to the next cue', () => {
    const body = dualSubtitleVtt({
      sourceSegments: [
        { seq: 0, startMs: 0, endMs: 1_000, text: 'One.' },
        { seq: 1, startMs: 1_000, endMs: 2_000, text: 'Two.' },
      ],
      segments: [
        { seq: 0, startMs: 0, endMs: 1_000, text: '하나.' },
        { seq: 1, startMs: 1_000, endMs: 2_000, text: '' },
        { seq: 2, startMs: 3_000, endMs: 4_000, text: '셋.' },
      ],
    })
    expect(body).toContain('00:00:00.000 --> 00:00:03.000')
    expect(body).not.toContain('\n\n\n')
    expect(body.trimEnd().split('\n\n')).toHaveLength(3) // header plus two cues
  })

  test('flattens a line break inside a stored cue', () => {
    const body = dualSubtitleVtt({
      sourceSegments: [{ seq: 0, startMs: 0, endMs: 1_000, text: 'A\nB' }],
      segments: [{ seq: 0, startMs: 0, endMs: 1_000, text: '가\n나' }],
    })
    expect(body).toContain('A B\n가 나')
  })
})
