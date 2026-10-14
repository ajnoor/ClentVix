import { describe, it, expect } from 'vitest'
import { searchPlaces, ProviderError } from '../lib/places'

describe('FreeSerp discovery', () => {
  it('extracts business websites and filters directories and duplicates', async () => {
    const payload = {
      ok: true,
      results: [
        {
          url: 'https://brightonimplantclinic.co.uk/',
          title: 'Brighton Implant Clinic | Dentist',
          snippet: 'Dental implants and general dentistry',
        },
        {
          url: 'https://brightonimplantclinic.co.uk/contact',
          title: 'Contact Brighton Implant Clinic',
          snippet: 'Contact details',
        },
        {
          url: 'https://www.freeindex.co.uk/profile/example.htm',
          title: 'Example Dental Clinic',
          snippet: 'Directory listing',
        },
        {
          url: 'https://smilebrighton.example/',
          title: 'Smile Brighton - Dental Clinic',
          snippet: 'Dental care in Brighton',
        },
      ],
    }

    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })

    const results = await searchPlaces(
      { businessType: 'dental clinics', location: 'Brighton, UK', maxResults: 5 },
      fakeFetch,
    )

    expect(results).toHaveLength(2)
    expect(results[0].name).toBe('Brighton Implant Clinic')
    expect(results[0].snippet).toContain('Dental implants')
    expect(results[1].name).toBe('Smile Brighton')
  })

  it('reports provider errors when FreeSerp is unavailable', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('Service unavailable', { status: 503 })

    await expect(
      searchPlaces(
        { businessType: 'dentists', location: 'Brighton, UK', maxResults: 5 },
        fakeFetch,
      ),
    ).rejects.toThrow(ProviderError)
  })
})
