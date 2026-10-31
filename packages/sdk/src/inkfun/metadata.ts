/** Text and links of a launch, read from the token's metadata JSON. */
export type LaunchMetadataFields = {
  description: string | null
  imageUrl: string | null
  links: { telegram: string | null; twitter: string | null; website: string | null }
}
