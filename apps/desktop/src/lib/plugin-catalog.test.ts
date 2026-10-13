import { JSON_RPC_METHOD_NOT_FOUND, JsonRpcGatewayError } from '@hermes/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as gatewayStore from '@/store/gateway'
import { $gatewayState } from '@/store/session'

import { type CatalogLookupReply, type CatalogRequest, lookupPluginCatalogEntry } from './plugin-catalog'

const SHA = 'a'.repeat(40)

const replying =
  (reply: CatalogLookupReply | null | undefined): CatalogRequest =>
  async () =>
    reply

const noFetch = vi.fn<typeof fetch>(async () => {
  throw new Error('the renderer must not fetch the docs host when the backend answers')
})

describe('lookupPluginCatalogEntry', () => {
  it('asks the backend for the entry, not the docs host', async () => {
    const found = { name: 'aihubmix', repo: 'https://github.com/AIhubmix/mono', sha: SHA, subdir: 'aihubmix' }
    const request = vi.fn<CatalogRequest>(async () => ({ status: 'found', entry: found }))

    await expect(lookupPluginCatalogEntry(' aihubmix ', { fetchImpl: noFetch, request })).resolves.toEqual({
      ok: true,
      entry: found
    })
    expect(request.mock.calls).toEqual([['plugins.catalog.lookup', { name: 'aihubmix' }]])
    expect(noFetch).not.toHaveBeenCalled()
  })

  it.each([
    [{ status: 'unknown' }, 'unknown'],
    [{ status: 'invalid_name' }, 'invalid_name'],
    [{ status: 'unavailable' }, 'unavailable'],
    [{ status: 'found', entry: { name: 'x' } }, 'unavailable'],
    [{ status: 'something-new' }, 'unavailable'],
    [null, 'unavailable'],
    [undefined, 'unavailable']
  ] as const)('backend %j → %s, with no fetch', async (reply, error) => {
    await expect(
      lookupPluginCatalogEntry('weather', { fetchImpl: noFetch, request: replying(reply) })
    ).resolves.toEqual({
      ok: false,
      error
    })
  })

  it('refuses a non-catalog name before asking anyone', async () => {
    const request = vi.fn<CatalogRequest>(async () => ({ status: 'found' }))

    await expect(lookupPluginCatalogEntry('../etc', { fetchImpl: noFetch, request })).resolves.toEqual({
      ok: false,
      error: 'invalid_name'
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('falls back to the direct feed only when the backend predates the lookup', async () => {
    const feed = [{ name: 'weather', repo: 'https://github.com/x/weather', sha: SHA, subdir: '' }]
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(feed)))

    const request: CatalogRequest = async () => {
      throw new JsonRpcGatewayError('method not found: plugins.catalog.lookup', { code: JSON_RPC_METHOD_NOT_FOUND })
    }

    await expect(lookupPluginCatalogEntry('weather', { fetchImpl, request })).resolves.toMatchObject({
      ok: true,
      entry: { name: 'weather', repo: 'https://github.com/x/weather' }
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('reads an unreachable backend as unavailable, without fetching', async () => {
    const request: CatalogRequest = async () => {
      throw new Error('Hermes gateway unavailable for profile "default"')
    }

    await expect(lookupPluginCatalogEntry('weather', { fetchImpl: noFetch, request })).resolves.toEqual({
      ok: false,
      error: 'unavailable'
    })
    expect(noFetch).not.toHaveBeenCalled()
  })
})

describe('lookupPluginCatalogEntry at cold start (the link launched Desktop)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    $gatewayState.set('idle')
  })

  it('waits for the gateway to open before routing the lookup, then resolves', async () => {
    $gatewayState.set('connecting')
    const found = { name: 'weather', repo: 'https://github.com/x/weather', sha: SHA, subdir: '' }

    const spy = vi
      .spyOn(gatewayStore, 'requestGatewayForProfile')
      .mockImplementation(async () => ({ status: 'found', entry: found }) as never)

    const pending = lookupPluginCatalogEntry('weather', { fetchImpl: noFetch })
    await Promise.resolve()
    expect(spy).not.toHaveBeenCalled() // nothing is routed while the backend is still booting

    $gatewayState.set('open')

    await expect(pending).resolves.toMatchObject({ ok: true, entry: { name: 'weather', repo: found.repo, sha: SHA } })
    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      'plugins.catalog.lookup',
      { name: 'weather' },
      expect.any(Number)
    )
  })

  it('ends in "unavailable" when route resolution stalls, instead of never settling', async () => {
    vi.useFakeTimers()
    $gatewayState.set('open')
    vi.spyOn(gatewayStore, 'requestGatewayForProfile').mockImplementation(() => new Promise(() => {}))

    const pending = lookupPluginCatalogEntry('weather', { fetchImpl: noFetch })
    await vi.advanceTimersByTimeAsync(25_000)

    await expect(pending).resolves.toEqual({ ok: false, error: 'unavailable' })
  })

  it('ends in "unavailable" when the gateway never opens', async () => {
    vi.useFakeTimers()
    $gatewayState.set('connecting')
    const spy = vi.spyOn(gatewayStore, 'requestGatewayForProfile')

    const pending = lookupPluginCatalogEntry('weather', { fetchImpl: noFetch })
    await vi.advanceTimersByTimeAsync(181_000)

    await expect(pending).resolves.toEqual({ ok: false, error: 'unavailable' })
    expect(spy).not.toHaveBeenCalled()
  })
})
