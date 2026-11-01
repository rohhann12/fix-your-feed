export const SYSTEM = 'You help a user reshape their YouTube recommendations. Answer only with the requested structured output. Be concrete and decisive.';

const strings = { type: 'array', items: { type: 'string' } };

export const tasks = {
  plan: {
    schema: {
      type: 'object',
      properties: { niche: { type: 'string' }, avoid: { type: 'string' }, queries: strings },
      required: ['niche', 'avoid', 'queries'],
      additionalProperties: false,
    },
    prompt: ({ description }) => `The user wants their YouTube home feed to look like this:

"""${description}"""

1. niche: restate what they want in one precise sentence.
2. avoid: one sentence on what clearly does NOT belong (infer from their wording; e.g. "calm" implies no clickbait/drama).
3. queries: 10 diverse YouTube search queries that surface creators who consistently make this content. Cover different sub-topics and formats, use the words creators put in titles, and include a couple of queries naming well-known creators in the space if you know any. No duplicates.`,
  },

  pick: {
    schema: {
      type: 'object',
      properties: {
        channels: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, reason: { type: 'string' } },
            required: ['id', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['channels'],
      additionalProperties: false,
    },
    prompt: ({ description, plan, candidates, count }) => `The user wants this YouTube feed:
"""${description}"""
Niche: ${plan.niche}
Avoid: ${plan.avoid}

Below are real channels found by searching YouTube, with their recent upload titles and how many days ago they last uploaded. Pick the ${count} channels that best match, ranked best first.

Prefer channels whose recent uploads are consistently on-niche, that uploaded within the last ~6 months, and a mix of big and mid-size creators. Skip channels under ~5k subscribers unless nothing better exists: the recommender learns little from tiny channels. Reject reupload/compilation farms, kids content, AI slop, and channels that only touch the topic occasionally. If fewer than ${count} are genuinely good, return fewer. Use the exact "id" values from the list. reason: under 12 words.

Candidates:
${JSON.stringify(candidates)}`,
  },

  classify: {
    schema: {
      type: 'object',
      properties: { offNiche: strings },
      required: ['offNiche'],
      additionalProperties: false,
    },
    prompt: ({ description, plan, tiles }) => `The user wants this YouTube feed:
"""${description}"""
Niche: ${plan.niche}
Avoid: ${plan.avoid}

These videos are on their home feed right now. Return the "id" of every video that clearly does not belong in the feed they described, so we can mark it "Not interested". Keep anything on-niche or closely adjacent. When unsure, keep it.

${JSON.stringify(tiles)}`,
  },
};
