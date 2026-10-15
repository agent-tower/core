import { describe, expect, it } from 'vitest'
import { formatNumber, formatPercent, formatSignedNumber, formatSignedPercent } from '../format'

describe('formatNumber', () => {
  it('groups thousands and keeps one decimal for small numbers', () => {
    expect(formatNumber(1234, { locale: 'en-US' })).toBe('1,234')
    expect(formatNumber(3.14159, { locale: 'en-US' })).toBe('3.1')
  })

  it('uses compact notation per locale', () => {
    expect(formatNumber(12_800, { compact: true, locale: 'en-US' })).toBe('12.8K')
    expect(formatNumber(12_800, { compact: true, locale: 'zh-CN' })).toBe('1.3万')
  })

  it('renders a dash for non-finite values', () => {
    expect(formatNumber(Number.NaN)).toBe('—')
  })
})

describe('formatPercent', () => {
  it('turns a ratio into a percentage', () => {
    expect(formatPercent(0.873)).toBe('87%')
    expect(formatPercent(0.125, 1)).toBe('12.5%')
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

describe('formatSignedPercent', () => {
  it('prefixes a plus sign or a true minus sign', () => {
    expect(formatSignedPercent(0.12)).toBe('+12%')
    expect(formatSignedPercent(-0.031)).toBe('−3.1%')
  })

  it('drops the sign when the change rounds to zero', () => {
    expect(formatSignedPercent(0)).toBe('0%')
    expect(formatSignedPercent(0.0004)).toBe('0%')
    expect(formatSignedPercent(-0.0004)).toBe('0%')
  })
})

describe('formatSignedNumber', () => {
  it('prefixes a plus sign or a true minus sign', () => {
    expect(formatSignedNumber(3)).toBe('+3')
    expect(formatSignedNumber(-2)).toBe('−2')
    expect(formatSignedNumber(0)).toBe('0')
  })
})
