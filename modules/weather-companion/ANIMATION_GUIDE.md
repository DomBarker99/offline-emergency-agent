# Outdoor window animation process

Status: visual exploration, awaiting user review. Five manually selected hazard studies; the API remains flood-only.

## Art brief

A tiny paper-cut neighborhood seen through a rounded window. Warm ivory, sage foliage, dusty blue water, muted terracotta roofs. Large rounded silhouettes, a familiar house, soft depth, generous empty sky. Calm and approachable without smiling disasters or comic distress. Keep the house and camera in the same position across scenarios. One main motion communicates the change; ambient motion stays secondary.

## Development cycle

1. Define what each of the three stages means and which evidence permits it. Never infer severity from animation.
2. Draw three still key poses. Check silhouettes and readability at 320px. Review art before production wiring.
3. Animate a short study with gentle easing, overlapping movement, consistent proportions, and at most three motion ideas.
4. Compare stages. The accompanying condition must make sense without motion or color.
5. Inspect narrow layout, keyboard controls, pause, reduced motion, and hidden-tab behavior. No flashes or whole-interface shaking.
6. Connect accepted visuals to validated context. Classification belongs in the processor; the renderer illustrates it.

## Hazard vocabulary

| Hazard | Steady | Prepare | Event | Main motion |
| --- | --- | --- | --- | --- |
| Flood | Light rain | Rising water, heavier rain | Foreground inundation | Rain and waterline |
| Wildfire | Clear air | Warm dry palette, no flames | Distant fire and smoke | Smoke drift |
| Earthquake | Still scene | General readiness, not prediction | Detected shaking | Brief damped shake |
| Power outage | Warm windows | Lit scene, text explains risk | Lights fade out | Lighting transition |
| Extreme heat | Soft sun | Faint shimmer | Warm palette, clearer shimmer | Rising heat lines |

These are manually chosen illustrative fixtures, not operational alert criteria. Illustrated distance and waterline are not measurements. The intact house does not establish safety. Earthquake readiness is not a forecast. Production copy should come from verified context, replacing the study's explanatory copy.

## Reusable coding-agent prompt

> Build one reviewable outdoor-window animation using the existing local GSAP library. Follow the art brief. Define three key poses and the information each communicates. Preserve the familiar camera, house, proportions, and palette. Use no more than three intentional motion ideas with restrained easing and overlap. Keep a plain-language condition beside the scene. Include pause, replay, and reduced-motion handling. Inspect a narrow browser screenshot. Report what is fixture data and what is connected to the backend. Do not add operational predictions or new backend capabilities.

## Handoff boundary

Proposed renderer inputs: hazard, stage, playing, plus optional validated visual values such as daylight or rainfall intensity. This is not yet a shared API contract. Production integration should show a neutral unavailable state for unknown inputs. This study has only local selected fixtures: no AI, microphone, chat, or alert detection.

## Sources applied

- [OpenAI frontend guide](https://developers.openai.com/blog/designing-delightful-frontends-with-gpt-5-4): specify a visual thesis, constraints, a few intentional motions, and inspect browser output. General guidance, not an Astra/Sol-specific recipe.
- [Adobe animation principles](https://www.adobe.com/creativecloud/animation/discover/principles-of-animation.html): staging, key poses, slow-in/slow-out, and overlapping motion. Appeal belongs to the illustration; the emergency is not a game.
- [GSAP easing](https://gsap.com/resources/getting-started/Easing/): use sine easing for gentle periodic motion and linear movement for falling rain.

Review page: /animation-studio. The companion screen (/companion) embeds it.

## Wildfire storyboard iteration

`public/wildfire-storyboard.png` defines four visual beats: ridge ignition, taller flames, downhill advance, and the final active front. The event preview interpolates these beats over 12 seconds, then holds its footprint while flames flicker and smoke drifts. Replay restarts the progression. The scorched area expands with the front; foreground artwork is composited above it. This is an illustrative scripted sequence, not a fire-spread forecast. Reduced motion shows the final footprint without playback.
