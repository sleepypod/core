import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { calendarNightPoints, nextCalendarOccurrence, nextCalendarTemperature } from '../calendarTemperature'

const row = (dayOfWeek: string, time: string, temperature: number, enabled = true) => ({ dayOfWeek, time, temperature, enabled })

describe('calendar-backed night previews', () => {
  it('keeps adjacent mornings distinct and preserves source calendar rows', () => {
    const rows = [row('monday', '06:00', 60), row('monday', '22:00', 80), row('tuesday', '06:00', 82), row('tuesday', '22:00', 75)]
    const original = structuredClone(rows)
    expect(calendarNightPoints(rows, 'monday')).toEqual([
      { time: '22:00', temperature: 80, dayOffset: 0 },
      { time: '06:00', temperature: 82, dayOffset: 1 },
    ])
    expect(rows).toEqual(original)
  })

  it('wraps Saturday into Sunday and excludes disabled or invalid clocks', () => {
    expect(calendarNightPoints([
      row('saturday', '12:00', 78), row('sunday', '00:00', 72), row('sunday', '11:59', 81),
      row('sunday', '12:00', 99), row('saturday', '01:00', 98),
      row('sunday', '06:00', 97, false), row('sunday', '99:00', 96),
    ], 'saturday')).toEqual([
      { time: '12:00', temperature: 78, dayOffset: 0 },
      { time: '00:00', temperature: 72, dayOffset: 1 },
      { time: '11:59', temperature: 81, dayOffset: 1 },
    ])
    expect(calendarNightPoints(undefined, 'monday')).toEqual([])
  })

  it('does not reuse a passed Sunday morning as the coming Monday morning', () => {
    const now = new Date(2026, 8, 28, 3)
    expect(nextCalendarTemperature([row('sunday', '06:00', 60), row('monday', '07:00', 82)], now))
      .toEqual({ at: new Date(2026, 8, 28, 7), time: '07:00', temperature: 82 })
    expect(nextCalendarOccurrence('sunday', '06:00', now)).toEqual(new Date(2026, 9, 4, 6))
    expect(nextCalendarTemperature(undefined, now)).toBeNull()
    expect(nextCalendarOccurrence('unknown', '06:00', now)).toBeNull()
    expect(nextCalendarOccurrence('sunday', '24:00', now)).toBeNull()
  })

  it('matches scheduler cron dates across spring-forward and fall-back on a separate local clock', () => {
    // A subprocess isolates the browser-local timezone without changing other tests.
    const result = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import parser from 'cron-parser';
      import { nextCalendarOccurrence } from './src/lib/calendarTemperature.ts';
      import { nightCurve } from './src/components/TempScreen/timelineLogic.ts';
      const cases = [
        ['2026-03-07T20:00:00-08:00', '02:30'],
        ['2026-11-01T00:30:00-07:00', '01:30'],
        ['2026-11-01T01:45:00-07:00', '01:30'],
      ];
      const matches = cases.map(([start, time]) => {
        const [hour, minute] = time.split(':').map(Number);
        const expected = parser.parseExpression(minute + ' ' + hour + ' * * 0', { currentDate: new Date(start), tz: 'America/Los_Angeles' }).next().toDate();
        return nextCalendarOccurrence('sunday', time, new Date(start)).getTime() === expected.getTime();
      });
      const rows = [{dayOfWeek:'saturday',time:'22:00',temperature:80,enabled:true}, {dayOfWeek:'sunday',time:'07:00',temperature:82,enabled:true}];
      const power = [{dayOfWeek:'saturday',onTime:'22:00',offTime:'07:00',offDayOffset:1,onTemperature:70,endAction:'turn_off',enabled:true}];
      const spring = nightCurve([], new Date(2026, 2, 7), power);
      const fall = nightCurve([], new Date(2026, 9, 31), power);
      matches.push(nightCurve(rows, new Date(2026, 2, 7))[0].at === spring[0].at);
      console.log(JSON.stringify({ matches, springHours:(spring[1].at-spring[0].at)/3600000, fallHours:(fall[1].at-fall[0].at)/3600000 }));
    `], { cwd: process.cwd(), env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8', timeout: 20_000 })
    expect(JSON.parse(result)).toEqual({ matches: [true, true, true, true], springHours: 8, fallHours: 10 })
  })
})
