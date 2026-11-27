import { describe, expect, it } from "vitest";
import {
  addVideoCloneTakes,
  buildTakes,
  continuityFrames,
  estimateVideoCloneRenderUsd,
  hasTooManyCuts,
  keepsOriginal,
  layoutVideoCloneEdit,
  normalizeVideoModelId,
  numberVideoCloneProducts,
  renderSecondsForModel,
  resolveTakePromptReferences,
  sayVideoCloneLines,
  settleDeadRenders,
  sharesContinuity,
  shotsFromCuts,
  stageVideoClonePrompt,
  type VideoClone,
  videoCloneEditClips,
  videoCloneMismatch,
  videoClonePartPrompt,
  videoCloneStory,
  videoCloneStoryTime,
  videoCloneTextOverlays,
  videoCloneUrlSchema,
  videoCloneVerdict,
} from "./video-clone";

/** A take's analysis where what's in it doesn't matter. */
const takeAnalysis = {
  description: "",
  shotType: "",
  camera: "",
  action: "",
  charactersInShot: [],
  needsCreatorReference: false,
  needsProductReference: false,
  dialogue: [],
  onScreenText: "",
  difficulty: "easy" as const,
  difficultyReason: "",
  notes: "",
  prompt: "",
};

describe("continuityFrames", () => {
  const part = (shot: number, takeStart: number, takeEnd: number) => ({
    shot,
    sceneId: null,
    srcStart: 0,
    srcEnd: 0,
    takeStart,
    takeEnd,
  });
  // Living room, dressing room (she changes), back to the living room in the gown.
  const room = { index: 1, parts: [part(1, 0, 10)] };
  const dressing = { index: 2, parts: [part(2, 0, 4), part(3, 4, 12)] };
  const reveal = { index: 3, parts: [part(4, 0, 6), part(5, 6, 14)] };
  const continuity = [
    { label: "the woman's gown", shots: [3, 4] },
    { label: "the living room", shots: [1, 5] },
    { label: "the man's look", shots: [1, 5] },
  ];

  it("references the rendered takes sharing a look, one frame per spot", () => {
    expect(
      continuityFrames(reveal.parts, [room, dressing], continuity),
    ).toEqual([
      { take: 2, shot: 3, labels: ["the woman's gown"] },
      { take: 1, shot: 1, labels: ["the living room", "the man's look"] },
    ]);
    // Take 1 isn't rendered: only the gown has a source.
    expect(continuityFrames(reveal.parts, [dressing], continuity)).toEqual([
      { take: 2, shot: 3, labels: ["the woman's gown"] },
    ]);
    expect(sharesContinuity(room, dressing, continuity)).toBe(false);
    expect(sharesContinuity(dressing, reveal, continuity)).toBe(true);
  });

  it("frames a look at its best shot, else its least crowded one, not the longest", () => {
    // The elevator: she walks in alone (3s), then 11s of the two women gossiping, her back to us.
    const walkIn = { index: 1, parts: [part(1, 0, 3), part(2, 3, 14)] };
    const reply = [part(5, 0, 6)];
    const looks = [
      { label: "her look", shots: [1, 2, 5] },
      { label: "the women's looks", shots: [2, 5] },
      { label: "the elevator", shots: [1, 2, 5], bestShot: 2 },
    ];
    expect(continuityFrames(reply, [walkIn], looks)).toEqual([
      { take: 1, shot: 1, labels: ["her look"] },
      { take: 1, shot: 2, labels: ["the women's looks", "the elevator"] },
    ]);
    // Shot 1 redone alone: the rest of its own take comes first.
    expect(
      continuityFrames(
        [part(1, 0, 3)],
        [{ index: 1, parts: [part(2, 3, 14)] }],
        looks,
      ),
    ).toEqual([{ take: 1, shot: 2, labels: ["her look", "the elevator"] }]);
  });
});

describe("resolveTakePromptReferences & canonical model helpers", () => {
  const atImageDialect = {
    formatImageToken: (slot: number) => `@image${slot}`,
    maxImages: 30,
    modelLabel: "Seedance 2.5",
  };
  const wanDialect = {
    formatImageToken: (slot: number) => `Image${slot}`,
    maxImages: 10,
    modelLabel: "Wan 3.0",
  };

  it("numbers reference images in the order their tokens are wired", () => {
    const resolved = resolveTakePromptReferences(
      "{{creator}} holds {{product}}; {{creator}} smiles. {{frame1}} shows her gown.",
      {
        creator: "https://img/creator.jpg",
        products: ["https://img/product.jpg"],
        frames: ["https://img/frame.jpg"],
      },
      atImageDialect,
    );
    expect(resolved.prompt).toBe(
      "@image1 holds @image2; @image1 smiles. @image3 shows her gown.",
    );
    expect(resolved.imageUrls).toEqual([
      "https://img/creator.jpg",
      "https://img/product.jpg",
      "https://img/frame.jpg",
    ]);
  });

  it("sends only the products a take mentions, in order of mention", () => {
    const resolved = resolveTakePromptReferences(
      "{{product3}} next to {{product1}}, then {{product3}} and {{product11}}.",
      {
        creator: "https://img/creator.jpg",
        products: [
          "https://img/p1.jpg",
          "https://img/p2.jpg",
          "https://img/p3.jpg",
        ],
      },
      atImageDialect,
    );
    expect(resolved.prompt).toBe(
      "@image1 next to @image2, then @image1 and the product.",
    );
    expect(resolved.imageUrls).toEqual([
      "https://img/p3.jpg",
      "https://img/p1.jpg",
    ]);
  });

  it("wires recast characters, sending an avatar once when it plays two parts", () => {
    const resolved = resolveTakePromptReferences(
      "{{cast:guest_1}} asks {{creator}}; {{cast:host}} laughs.",
      {
        creator: "https://img/ava.jpg",
        cast: new Map([
          ["guest_1", "https://img/bob.jpg"],
          ["host", "https://img/ava.jpg"],
        ]),
        products: [],
      },
      atImageDialect,
    );
    expect(resolved.prompt).toBe("@image1 asks @image2; @image2 laughs.");
    expect(resolved.imageUrls).toEqual([
      "https://img/bob.jpg",
      "https://img/ava.jpg",
    ]);
  });

  it("writes a person or product without an image as its plan description", () => {
    const resolved = resolveTakePromptReferences(
      "{{creator}} holds {{product}}; {{cast:guest}} nods at {{cast:extra}}.",
      {
        products: [],
        characters: [
          { id: "guest", reference: "none", description: "Man in a red cap" },
          {
            id: "host",
            reference: "creator",
            description: "Blonde woman in a cowboy hat.",
          },
        ],
        product: { present: true, description: "Pale pink lace bra." },
      },
      atImageDialect,
    );
    expect(resolved.prompt).toBe(
      "Blonde woman in a cowboy hat holds Pale pink lace bra; Man in a red cap nods at the person.",
    );
    expect(resolved.imageUrls).toEqual([]);
    expect(renderSecondsForModel(2.4, 4, 30)).toBe(4);
  });

  it("formats custom model token dialects and refuses excess reference images", () => {
    const wan = resolveTakePromptReferences(
      "{{creator}} holds {{product}}.",
      {
        creator: "https://img/creator.jpg",
        products: ["https://img/product.jpg"],
      },
      wanDialect,
    );
    expect(wan.prompt).toBe("Image1 holds Image2.");

    const products = Array.from(
      { length: 11 },
      (_, i) => `https://img/p${i}.jpg`,
    );
    const prompt = products.map((_, i) => `{{product${i + 1}}}`).join(" ");
    expect(() =>
      resolveTakePromptReferences(prompt, { products }, wanDialect),
    ).toThrow("up to 10 reference images");
  });

  it("normalizes legacy KIE model aliases and computes capability-based pricing", () => {
    expect(normalizeVideoModelId("bytedance/seedance-2-5")).toBe(
      "seedance-2.5",
    );
    expect(normalizeVideoModelId("wan/3-0-video")).toBe("wan-3.0");
    expect(normalizeVideoModelId(undefined)).toBe("seedance-2.5");

    const usd = estimateVideoCloneRenderUsd(
      [
        { seconds: 2.4, model: "bytedance/seedance-2-5" },
        { seconds: 3.2, model: "wan/3-0-video" },
      ],
      [
        {
          id: "seedance-2.5",
          minSeconds: 4,
          maxSeconds: 30,
          usdPerSecond: 0.14,
        },
        { id: "wan-3.0", minSeconds: 2, maxSeconds: 30, usdPerSecond: 0.04 },
      ],
    );
    expect(usd).toBeCloseTo(4 * 0.14 + 4 * 0.04);
  });
});

describe("keepsOriginal", () => {
  const manual = { analysis: { difficulty: "manual" as const } };
  const easy = { analysis: { difficulty: "easy" as const } };

  it("keeps manual takes original until a model is picked or they were rendered", () => {
    expect(keepsOriginal(manual)).toBe(true);
    expect(keepsOriginal({ ...manual, keepOriginal: false })).toBe(false);
    expect(keepsOriginal({ ...manual, generation: { status: "done" } })).toBe(
      false,
    );
    expect(keepsOriginal(easy)).toBe(false);
    expect(keepsOriginal({ ...easy, keepOriginal: true })).toBe(true);
  });
});

describe("settleDeadRenders", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  const startedAt = "2026-10-24T09:00:00Z"; // 3h ago
  const generating = {
    status: "generating" as const,
    prompt: "",
    changes: "",
    startedAt,
  };
  const plan = (takes: number) =>
    ({
      takes: Array.from({ length: takes }, (_, k) => ({
        index: k + 1,
        generation: generating,
        parts: [{ shot: k + 1, generation: generating }],
      })),
      edit: { status: "stitching", rendered: [], startedAt },
    }) as unknown as VideoClone;

  it("fails a render and stitch whose run outlived an hour per take, plus one", () => {
    const settled = settleDeadRenders(plan(1), now);
    expect(settled.takes[0]?.generation?.status).toBe("failed");
    expect(settled.takes[0]?.parts[0]?.generation?.status).toBe("failed");
    expect(settled.edit?.status).toBe("failed");
  });

  it("leaves a longer plan's run rendering: its takes render one round after another", () => {
    const settled = settleDeadRenders(plan(3), now);
    expect(settled.takes.map((take) => take.generation?.status)).toEqual([
      "generating",
      "generating",
      "generating",
    ]);
    expect(settled.edit?.status).toBe("stitching");
  });
});

describe("buildTakes", () => {
  it("renders a video that fits one generation as one take, in story order", () => {
    // Outfit change: living room, dressing room, back to the living room in 26s.
    const shots = shotsFromCuts([8, 14.5], 26.05);
    const scenes: Record<number, string> = { 1: "room", 2: "dress", 3: "room" };
    const takes = buildTakes(shots, (index) => scenes[index]);
    expect(takes.map((take) => take.parts.map((part) => part.shot))).toEqual([
      [1, 2, 3],
    ]);
    expect(takes[0]?.parts[2]).toMatchObject({
      srcStart: 14.5,
      takeStart: 14.5,
      takeEnd: 26.05,
    });
  });

  it("puts a scene's shots in one take and maps each part back to its original time", () => {
    // Cooper, past 30s: the video cuts between a plaza scene (1, 3) and a sidewalk scene (2, 4).
    const shots = shotsFromCuts([5.9, 10.27, 16.27], 32.43);
    const scenes: Record<number, string> = {
      1: "plaza",
      2: "sidewalk",
      3: "plaza",
      4: "sidewalk",
    };
    const takes = buildTakes(shots, (index) => scenes[index]);

    expect(takes.map((take) => take.parts.map((part) => part.shot))).toEqual([
      [1, 3],
      [2, 4],
    ]);
    expect(takes[0]?.parts).toEqual([
      {
        shot: 1,
        sceneId: "plaza",
        srcStart: 0,
        srcEnd: 5.9,
        takeStart: 0,
        takeEnd: 5.9,
      },
      {
        shot: 3,
        sceneId: "plaza",
        srcStart: 10.27,
        srcEnd: 16.27,
        takeStart: 5.9,
        takeEnd: 11.9,
      },
    ]);
    expect(takes[0]?.seconds).toBe(11.9);
  });

  it("starts a new take when a scene would pass Seedance's 30s", () => {
    const shots = shotsFromCuts([20, 40], 60);
    const takes = buildTakes(shots, () => "same-room");
    expect(takes.map((take) => take.seconds)).toEqual([20, 20, 20]);
  });

  it("splits a single shot longer than one take", () => {
    expect(shotsFromCuts([], 70).map((shot) => [shot.start, shot.end])).toEqual(
      [
        [0, 23.33],
        [23.33, 46.67],
        [46.67, 70],
      ],
    );
  });

  it("packs montage micro-shots from different scenes until a take reaches 4s", () => {
    const shots = shotsFromCuts([0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5], 5);
    const takes = buildTakes(shots, (index) => `scene-${index}`);
    // 8 shots fill the first 4s; the last 2 (1s) join it rather than becoming a 1s take.
    expect(takes.map((take) => take.parts.length)).toEqual([10]);
    expect(hasTooManyCuts(takes[0] as (typeof takes)[number])).toBe(true);
  });

  it("never leaves a flash cut between long scenes as its own take", () => {
    // A 0.4s title flash between two long scenes: Gemini rejects clips that short.
    const shots = shotsFromCuts([20, 20.4], 36.4);
    const scenes: Record<number, string> = {
      1: "kitchen",
      2: "title",
      3: "car",
    };
    const takes = buildTakes(shots, (index) => scenes[index]);
    expect(takes.map((take) => take.parts.map((part) => part.shot))).toEqual([
      [1],
      [3, 2],
    ]);
    expect(takes[1]?.parts[1]).toMatchObject({
      srcStart: 20,
      srcEnd: 20.4,
      takeStart: 16,
      takeEnd: 16.4,
    });
  });
});

describe("layoutVideoCloneEdit", () => {
  const part = (srcStart: number, srcEnd: number, takeStart: number) => ({
    shot: srcStart,
    sceneId: null as string | null,
    srcStart,
    srcEnd,
    takeStart,
    takeEnd: Math.round((takeStart + srcEnd - srcStart) * 100) / 100,
  });
  // A street interview: take 1 cuts back to the plaza twice, take 2 sits between.
  const takes = [
    {
      index: 1,
      parts: [part(0, 5.9, 0), part(10, 16, 5.9), part(20, 20.8, 11.9)],
    },
    { index: 2, parts: [part(5.9, 10, 0), part(16, 20, 4.1)] },
  ];

  it("cuts a render at its own cuts and keeps the original's footage where a take isn't rendered", () => {
    // Seedance cut 0.7s early, then 0.1s late; its last part plays to the render's end.
    const snapped = layoutVideoCloneEdit(
      { takes },
      new Map([[1, { cuts: [5.2, 12], duration: 13 }]]),
    );
    expect(
      snapped.map(({ take, start, end, editStart, editEnd }) => [
        take,
        start,
        end,
        editStart,
        editEnd,
      ]),
    ).toEqual([
      [1, 0, 5.2, 0, 5.2],
      [2, 5.9, 10, 5.2, 9.3],
      [1, 5.2, 12, 9.3, 16.1],
      [2, 16, 20, 16.1, 20.1],
      [1, 12, 13, 20.1, 21.1],
    ]);
  });

  it("pairs a render's cuts with the planned ones when Seedance adds or drops a cut", () => {
    // An extra cut inside the last part (12.3) is skipped instead of shifting every part.
    const extra = layoutVideoCloneEdit(
      { takes },
      new Map([[1, { cuts: [5.2, 12, 12.3], duration: 13 }]]),
    );
    expect(extra.filter(({ take }) => take === 1)).toMatchObject([
      { start: 0, end: 5.2 },
      { start: 5.2, end: 12 },
      { start: 12, end: 13 },
    ]);
    // No cut near 5.9: that boundary stays planned; the 12 still pairs.
    const missing = layoutVideoCloneEdit(
      { takes },
      new Map([[1, { cuts: [12], duration: 13 }]]),
    );
    expect(missing.filter(({ take }) => take === 1)).toMatchObject([
      { start: 0, end: 5.9 },
      { start: 5.9, end: 12 },
      { start: 12, end: 13 },
    ]);
  });

  it("plays a part redone alone from its own render", () => {
    const layout = layoutVideoCloneEdit(
      { takes },
      new Map([[1, { cuts: [5.2, 12], duration: 13 }]]),
      // The plaza's second part (planned 6s), redone in a 7s render.
      new Map([[10, 7]]),
    );
    expect(layout.filter(({ take }) => take === 1)).toMatchObject([
      { from: "take", start: 0, end: 5.2 },
      { from: "part", start: 0, end: 6 },
      { from: "take", start: 12, end: 13 },
    ]);
  });

  it("cuts a part from the earlier take render picked for it, at that render's own cuts", () => {
    const layout = layoutVideoCloneEdit(
      { takes },
      new Map([[1, { cuts: [5.2, 12], duration: 13 }]]),
      new Map(),
      // The plaza's second part plays take 1's earlier render, which cut later.
      new Map([[10, { cuts: [6.4, 12.8], duration: 14 }]]),
    );
    expect(layout.filter(({ take }) => take === 1)).toMatchObject([
      { from: "take", start: 0, end: 5.2 },
      { from: "take", start: 6.4, end: 12.8 },
      { from: "take", start: 12, end: 13 },
    ]);
  });

  it("plays an added take where the story puts it, once it's rendered", () => {
    const added = addVideoCloneTakes({ takes }, [
      {
        after: 10,
        sceneId: null,
        shows: [],
        partSeconds: [3, 2],
        analysis: takeAnalysis,
      },
    ]);
    const plan = { takes: [...takes, ...added.takes], story: added.story };
    // Not rendered: nothing to play, the original carries on.
    expect(
      layoutVideoCloneEdit(plan, new Map()).map(({ part }) => part.shot),
    ).toEqual([0, 5.9, 10, 16, 20]);
    const rendered = layoutVideoCloneEdit(
      plan,
      new Map([[3, { cuts: [3.1], duration: 6 }]]),
    );
    expect(rendered.slice(2, 5)).toMatchObject([
      { take: 1, from: "source", editStart: 10, editEnd: 16 },
      { take: 3, from: "take", start: 0, end: 3.1, editEnd: 19.1 },
      { take: 3, from: "take", start: 3.1, end: 6, editEnd: 22 },
    ]);
  });
});

describe("videoCloneEditClips", () => {
  const part = (srcStart: number, srcEnd: number, takeStart: number) => ({
    shot: srcStart,
    sceneId: null,
    srcStart,
    srcEnd,
    takeStart,
    takeEnd: Math.round((takeStart + srcEnd - srcStart) * 100) / 100,
  });
  const done = (videoUrl: string) => ({
    status: "done" as const,
    prompt: "",
    changes: "",
    videoUrl,
    startedAt: "2026-10-23T00:00:00.000Z",
  });

  it("cuts each part from the file it plays, with the plan's cuts until a render's own are known", () => {
    const takes = [
      {
        index: 1,
        seconds: 13,
        analysis: takeAnalysis,
        generation: done("/v2.mp4"),
        parts: [
          part(0, 5.9, 0),
          // Plays take 1's earlier render, whose cuts no stitch has found yet.
          { ...part(10, 16, 5.9), takeRender: "/v1.mp4" },
          { ...part(20, 20.8, 11.9), generation: done("/redo.mp4") },
        ],
      },
      // Not rendered: the original's footage.
      {
        index: 2,
        seconds: 8,
        analysis: takeAnalysis,
        parts: [part(5.9, 10, 0)],
      },
    ];
    const known = {
      "/v2.mp4": { cuts: [5.2, 12], duration: 13 },
      "/redo.mp4": { cuts: [], duration: 2 },
    };
    const clips = videoCloneEditClips(
      { takes },
      (url, planned) => known[url as keyof typeof known] ?? planned,
    );
    expect(
      clips.map(({ part: { shot }, src, start, end }) => [
        shot,
        src,
        start,
        end,
      ]),
    ).toEqual([
      [0, "/v2.mp4", 0, 5.2],
      [5.9, undefined, 5.9, 10],
      [10, "/v1.mp4", 5.9, 11.9],
      // Its own render, up to the part's planned 0.8s.
      [20, "/redo.mp4", 0, 0.8],
    ]);
  });
});

describe("videoCloneTextOverlays", () => {
  it("plays a rendered take's captions in turns across the take, never over original footage", () => {
    const overlays = videoCloneTextOverlays(
      [
        { index: 1, analysis: { onScreenText: "Wait / what happened" } },
        { index: 2, analysis: { onScreenText: "Already in the footage" } },
      ],
      [
        { take: 1, from: "take", editStart: 0, editEnd: 2 },
        { take: 1, from: "part", editStart: 2, editEnd: 6.8 },
        { take: 2, from: "source", editStart: 6.8, editEnd: 9 },
      ],
    );
    // Each turn gets its share of the characters: 4 and 13 of 17.
    expect(overlays).toEqual([
      { text: "Wait", start: 0, end: 1.6 },
      { text: "what happened", start: 1.6, end: 6.8 },
    ]);
  });

  it("splits text too long for one screen at word boundaries", () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const overlays = videoCloneTextOverlays(
      [{ index: 1, analysis: { onScreenText: text } }],
      [{ take: 1, from: "take", editStart: 0, editEnd: 10 }],
    );
    expect(overlays.every((turn) => turn.text.length <= 90)).toBe(true);
    expect(overlays.map((turn) => turn.text).join(" ")).toBe(text);
    expect(overlays.at(-1)?.end).toBe(10);
  });
});

describe("addVideoCloneTakes", () => {
  const part = (shot: number, srcStart: number, srcEnd: number) => ({
    shot,
    sceneId: "plaza",
    srcStart,
    srcEnd,
    takeStart: 0,
    takeEnd: srcEnd - srcStart,
  });
  const plan = {
    takes: [
      { index: 1, parts: [part(1, 0, 6), part(3, 10, 16)] },
      { index: 2, parts: [part(2, 6, 10)] },
    ],
    continuity: [{ label: "the plaza", shots: [1, 3] }],
  };
  const add = (after: number, partSeconds: number[], shows: string[] = []) => ({
    after,
    sceneId: "plaza",
    shows,
    partSeconds,
    analysis: takeAnalysis,
  });

  it("slots new shots in after the given shot, in order, matching what they show", () => {
    const result = addVideoCloneTakes(plan, [
      add(1, [6, 4], ["the plaza"]),
      add(1, [5]),
      add(0, [4]),
    ]);
    expect(result.story).toEqual([7, 1, 4, 5, 6, 2, 3]);
    expect(result.takes.map((take) => [take.index, take.seconds])).toEqual([
      [3, 10],
      [4, 5],
      [5, 4],
    ]);
    // No footage of their own: an empty source span at the spot they play.
    expect(result.takes[0]?.parts).toMatchObject([
      { shot: 4, srcStart: 6, srcEnd: 6, takeStart: 0, takeEnd: 6 },
      { shot: 5, srcStart: 6, srcEnd: 6, takeStart: 6, takeEnd: 10 },
    ]);
    expect(result.continuity?.[0]?.shots).toEqual([1, 3, 4, 5]);
    expect(plan.continuity[0]?.shots).toEqual([1, 3]);
  });

  it("writes added takes again in their new place: merged, split, under their indexes", () => {
    // Take 3 (shots 4-5) plays after shot 1, take 4 (shot 6) after shot 3.
    const grown = addVideoCloneTakes(plan, [
      add(1, [6, 4], ["the plaza"]),
      add(3, [5]),
    ]);
    const withAdded = { ...grown, takes: [...plan.takes, ...grown.takes] };
    const merged = addVideoCloneTakes(withAdded, [
      { ...add(0, [5, 10]), replaces: [3, 4] },
    ]);
    // Their old shots leave; the new ones don't reuse their numbers.
    expect(merged.story).toEqual([7, 8, 1, 2, 3]);
    expect(merged.takes.map((take) => [take.index, take.seconds])).toEqual([
      [3, 15],
    ]);
    expect(merged.removed).toEqual([4]);
    expect(merged.continuity?.[0]?.shots).toEqual([1, 3]);
    const split = addVideoCloneTakes(withAdded, [
      { ...add(0, [5]), replaces: [3] },
      { ...add(3, [4]), replaces: [3] },
    ]);
    expect(split.story).toEqual([7, 1, 2, 3, 8, 6]);
    expect(split.takes.map((take) => take.index)).toEqual([3, 5]);
    expect(split.removed).toEqual([]);
    // Only added takes, placed after a shot that stays.
    expect(() =>
      addVideoCloneTakes(withAdded, [{ ...add(0, [5]), replaces: [1] }]),
    ).toThrow(/Take 1/u);
    expect(() =>
      addVideoCloneTakes(withAdded, [{ ...add(4, [5]), replaces: [3] }]),
    ).toThrow(/shot 4/u);
  });

  it("refuses what can't render", () => {
    expect(() => addVideoCloneTakes(plan, [add(9, [4])])).toThrow(/shot 9/u);
    expect(() => addVideoCloneTakes(plan, [add(1, [20, 11])])).toThrow(
      /0-30s/u,
    );
    expect(() =>
      addVideoCloneTakes(
        plan,
        Array.from({ length: 20 }, () => add(3, [30])),
      ),
    ).toThrow(/10 minutes/u);
  });
});

describe("videoCloneStoryTime", () => {
  const part = (shot: number, srcStart: number, srcEnd: number) => ({
    shot,
    sceneId: null as string | null,
    srcStart,
    srcEnd,
    takeStart: 0,
    takeEnd: srcEnd - srcStart,
  });
  const takes = [{ index: 1, parts: [part(1, 0, 5.9), part(2, 5.9, 10)] }];
  const story = videoCloneStory({ takes });
  // An edit stitched before parts carried their shot.
  const parts = [
    { srcStart: 0, srcEnd: 5.9, start: 0, end: 5.2 },
    { srcStart: 5.9, srcEnd: 10, start: 5.2, end: 9.3 },
  ];

  it("maps both ways through the part playing at that time", () => {
    expect(videoCloneStoryTime(story, parts, 7, "video")).toBeCloseTo(6.3);
    expect(videoCloneStoryTime(story, parts, 6.3, "story")).toBeCloseTo(7);
    // Halfway through a part that the render played shorter.
    expect(videoCloneStoryTime(story, parts, 2.6, "story")).toBeCloseTo(2.95);
    // The original plays the story at its own times, and past the end clamps.
    expect(videoCloneStoryTime(story, undefined, 4, "video")).toBeCloseTo(4);
    expect(videoCloneStoryTime(story, parts, 50, "video")).toBeCloseTo(9.3);
  });

  it("puts an added take between the original's shots", () => {
    const added = addVideoCloneTakes({ takes }, [
      {
        after: 0,
        sceneId: null,
        shows: [],
        partSeconds: [10],
        analysis: takeAnalysis,
      },
    ]);
    const longer = videoCloneStory({
      takes: [...takes, ...added.takes],
      story: added.story,
    });
    expect(longer.at(-1)?.end).toBe(20);
    // The original's 0:02 now plays at 0:12; the new opening sits at the original's start.
    expect(videoCloneStoryTime(longer, undefined, 2, "story")).toBeCloseTo(12);
    expect(videoCloneStoryTime(longer, undefined, 5, "video")).toBe(0);
  });
});

describe("videoCloneVerdict", () => {
  const take = (seconds: number, difficulty: "easy" | "hard" | "manual") => ({
    seconds,
    analysis: { difficulty },
  });

  it("skips when over 40% of the seconds must be made by hand", () => {
    expect(videoCloneVerdict([take(5, "easy"), take(5, "manual")])).toBe(
      "skip",
    );
    expect(videoCloneVerdict([take(7, "easy"), take(3, "manual")])).toBe(
      "clone",
    );
  });

  it("clones even when most seconds are hard", () => {
    expect(videoCloneVerdict([take(9, "hard"), take(1, "easy")])).toBe("clone");
  });
});

describe("videoCloneUrlSchema", () => {
  it("keys the cache on the post, not its tracking params", () => {
    expect(
      videoCloneUrlSchema.parse(
        "https://www.tiktok.com/@sydgrows/video/7669695694738984194?is_from_webapp=1#x",
      ),
    ).toBe("https://www.tiktok.com/@sydgrows/video/7669695694738984194");
  });

  it("rejects other sites, including look-alike hosts", () => {
    expect(
      videoCloneUrlSchema.safeParse("https://youtube.com/watch?v=1").success,
    ).toBe(false);
    expect(
      videoCloneUrlSchema.safeParse("https://nottiktok.com/@a/video/1").success,
    ).toBe(false);
  });
});

describe("numberVideoCloneProducts", () => {
  it("numbers folder photos first and points each take at its pinned photos", () => {
    const ring = { url: "/s/ring.jpg" };
    const bag = { url: "/s/bag.jpg" };
    const { products, pinned } = numberVideoCloneProducts(
      [ring, bag],
      [
        { id: "pin-bag", url: "/s/bag.jpg" },
        { id: "pin-hat", url: "/s/hat.jpg" },
      ],
      [
        { index: 1, products: ["pin-hat", "pin-bag"] },
        { index: 2 },
        { index: 3, products: ["deleted-asset"] },
      ],
    );
    // A pinned photo already in the folder keeps the folder's number.
    expect(products.map((product) => product.url)).toEqual([
      "/s/ring.jpg",
      "/s/bag.jpg",
      "/s/hat.jpg",
    ]);
    expect([...pinned]).toEqual([[1, [3, 2]]]);
  });
});

describe("videoClonePartPrompt", () => {
  const prompt =
    "Vertical 9:16, warm light. Part 1 (0-2.9s): {{creator}} walks in. Hard cut. Part 2 (2.9–6.4s): The man says 'hi.' Hard cut. Part 3 (6.4-9s): {{creator}} laughs.";

  it("keeps the look and one part's beat, as one shot", () => {
    expect(videoClonePartPrompt(prompt, 1, 3.5)).toBe(
      "Vertical 9:16, warm light.\n\nThe man says 'hi.'\n\nOne continuous shot, no cuts; its action plays out over the first 3.5s.",
    );
    expect(videoClonePartPrompt(prompt, 2, 2.6)).toContain(
      "{{creator}} laughs.",
    );
  });

  it("finds nothing in a prompt without part labels", () => {
    expect(videoClonePartPrompt("{{creator}} waves.", 0, 2)).toBeNull();
    expect(videoClonePartPrompt(prompt, 5, 2)).toBeNull();
  });
});

describe("stageVideoClonePrompt", () => {
  it("writes each part's camera and listener after its label, so a redo of that part keeps them", () => {
    const prompt =
      "Vertical 9:16, warm light. Part 1 (0-2.9s): {{creator}} walks in. Hard cut. Part 2 (2.9-6.4s): The receptionist says 'Morning.' Hard cut. Part 3 (6.4-9s): {{creator}} laughs.";
    const staged = stageVideoClonePrompt(prompt, [
      { part: 1, camera: "inside the elevator, facing out", saidTo: "" },
      {
        part: 2,
        camera: "in the lobby, facing the desk.",
        saidTo: "the man stepping out of the elevator",
      },
    ]);
    expect(staged).toBe(
      "Vertical 9:16, warm light. Part 1 (0-2.9s): Camera: inside the elevator, facing out. {{creator}} walks in. Hard cut. Part 2 (2.9-6.4s): Camera: in the lobby, facing the desk. Said to: the man stepping out of the elevator. The receptionist says 'Morning.' Hard cut. Part 3 (6.4-9s): {{creator}} laughs.",
    );
    expect(videoClonePartPrompt(staged, 1, 3.5)).toContain(
      "Said to: the man stepping out of the elevator.",
    );
  });

  it("adds a one-shot take's staging after its prompt", () => {
    expect(
      stageVideoClonePrompt("{{creator}} waves.", [
        {
          part: 1,
          camera: "across the street",
          saidTo: "someone on the phone",
        },
      ]),
    ).toBe(
      "{{creator}} waves.\n\nCamera: across the street. Said to: someone on the phone.",
    );
  });
});

describe("videoCloneMismatch", () => {
  const render = (videoUrl: string, issue: string) => ({
    status: "done" as const,
    prompt: "",
    changes: "",
    startedAt: "",
    videoUrl,
    mismatches: [{ shot: 4, issue }],
  });

  it("reads the render the part plays: its own, else the take render picked for it, else the take's", () => {
    const take = {
      generation: render("/v2.mp4", "take v2"),
      renders: [render("/v1.mp4", "take v1")],
    };
    expect(videoCloneMismatch(take, { shot: 4 })).toBe("take v2");
    expect(videoCloneMismatch(take, { shot: 5 })).toBeUndefined();
    expect(videoCloneMismatch(take, { shot: 4, takeRender: "/v1.mp4" })).toBe(
      "take v1",
    );
    expect(
      videoCloneMismatch(take, {
        shot: 4,
        takeRender: "/v1.mp4",
        generation: render("/shot.mp4", "own"),
      }),
    ).toBe("own");
    expect(
      videoCloneMismatch(
        { generation: { ...render("/v3.mp4", "x"), status: "generating" } },
        { shot: 4 },
      ),
    ).toBeUndefined();
  });
});

describe("sayVideoCloneLines", () => {
  const prompt =
    'Part 1 (0-3s): {{creator}} says "No." Part 2 (3-6s): She says "Who is Dana?" He says "No." Part 3 (6-9s): She says "Fine."';
  const lines = [
    { speaker: "creator", text: "No." },
    { speaker: "partner", text: "Who is Dana?" },
    { speaker: "creator", text: "No." },
    { speaker: "partner", text: "Fine." },
  ];

  it("swaps an edited line where its own turn is quoted, even when the words repeat", () => {
    const edited = lines.map((line, i) =>
      i === 2 ? { ...line, text: " Okay, okay, she's from work. " } : line,
    );
    expect(sayVideoCloneLines(prompt, lines, edited)).toBe(
      'Part 1 (0-3s): {{creator}} says "No." Part 2 (3-6s): She says "Who is Dana?" He says "Okay, okay, she\'s from work." Part 3 (6-9s): She says "Fine."',
    );
  });

  it("gives up on a cut line, an added one, or a line the prompt doesn't quote", () => {
    const cut = lines.map((line, i) =>
      i === 1 ? { ...line, text: "" } : line,
    );
    expect(sayVideoCloneLines(prompt, lines, cut)).toBeNull();
    expect(
      sayVideoCloneLines(prompt, lines, [
        ...lines,
        { speaker: "x", text: "Hi." },
      ]),
    ).toBeNull();
    const unquoted = [
      ...lines.slice(0, 3),
      { speaker: "partner", text: "Fine!" },
    ];
    expect(
      sayVideoCloneLines(prompt, unquoted, [
        ...lines.slice(0, 3),
        { speaker: "partner", text: "Sure." },
      ]),
    ).toBeNull();
  });
});
