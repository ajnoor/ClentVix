// Pure types shared by server and client. Must NOT import server-only modules (pg, fs, ...).

export const STAGES = ['New', 'Reviewed', 'Contacted', 'Replied', 'Converted'] as const
export type Stage = (typeof STAGES)[number]
export type Priority = 'High' | 'Medium' | 'Low'

export type EvidenceItem = {
  /** 'website' = verbatim text found on the fetched page; 'provider' = fact reported by the search provider listing. */
  kind: 'website' | 'provider'
  text: string
  sourceUrl: string
  fetchedAt: string
}

export type Prospect = {
  id: string
  name: string
  domain: string
  websiteUrl: string
  category: string
  location: string
  address: string | null
  /** null = not analysed yet. Never a made-up number. */
  score: number | null
  priority: Priority | null
  stage: Stage
  saved: boolean
  reason: string
  evidence: string
  evidenceItems: EvidenceItem[]
  nextAction: string
  sourceProvider: string
  sourceUrl: string | null
  /** 'verified' only when at least one quote was found verbatim on the fetched website. */
  verificationStatus: 'verified' | 'unverified'
  analysisStatus: 'pending' | 'analyzed' | 'failed' | 'skipped'
  analysisError: string | null
  analyzedAt: string | null
  createdAt: string
  updatedAt: string
}

export type UserSettings = {
  serviceName: string
  valueProposition: string
  defaultBusinessType: string
  defaultLocation: string
}

export type DiscoveryRun = {
  id: string
  businessType: string
  location: string
  focus: string
  status: 'running' | 'completed' | 'failed'
  foundCount: number
  newCount: number
  analyzedCount: number
  error: string | null
  createdAt: string
  completedAt: string | null
  unread: boolean
}

export type DiscoveryResult = {
  discoveryId: string
  found: number
  added: number
  alreadyInList: number
  analyzed: number
  analysisFailed: number
  warnings: string[]
}

export type ProviderStatus = {
  places: boolean
  gemini: boolean
  geminiModel: string
  database: boolean
}
