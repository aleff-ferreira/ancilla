import { FORMS, HUES, MOODS, type AvatarMood } from "./faces.js";
import { Avatar } from "./Avatar.js";

/**
 * Every form in every mood, and each form's four variants, on one page. A development view for the browser demo
 * (`demo.html?gallery=avatars`): it is how the faces are looked at side by side, and it ships nowhere else.
 */
export function AvatarGallery(props: { hue?: number; glow?: number }) {
  const hue = props.hue ?? 232;
  const glow = props.glow ?? 65;
  const spec = (form: (typeof FORMS)[number]["form"], detail = 1, h = hue) => ({ form, hue: h, glow, detail, seed: 12345 });
  return (
    <div className="h-screen overflow-y-auto bg-app p-8 text-fg">
      <h1 className="mb-1 text-lg font-semibold">The assistant's face</h1>
      <p className="mb-6 text-sm text-muted">Each form in each mood; then each form's four variants; then each hue on the first form.</p>
      <div className="overflow-x-auto">
        <table className="border-separate border-spacing-x-3 border-spacing-y-3">
          <thead>
            <tr>
              <th />
              {MOODS.map((mood) => (
                <th key={mood} className="text-xs font-medium text-muted capitalize">{mood}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FORMS.map((f) => (
              <tr key={f.form}>
                <th className="pr-3 text-right text-xs font-medium text-muted">{f.name}</th>
                {MOODS.map((mood: AvatarMood) => (
                  <td key={mood} data-cell={`${f.form}-${mood}`}>
                    <Avatar spec={spec(f.form)} mood={mood} burst={1} size={132} stage look />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2 className="mt-8 mb-2 text-sm font-semibold">Variants</h2>
      <div className="flex flex-wrap gap-4" data-block="variants">
        {FORMS.flatMap((f) => [0, 1, 2, 3].map((d) => <Avatar key={`${f.form}${d}`} spec={spec(f.form, d)} size={96} stage />))}
      </div>
      <h2 className="mt-8 mb-2 text-sm font-semibold">Hues</h2>
      <div className="flex flex-wrap gap-4" data-block="hues">
        {HUES.map((h) => (
          <Avatar key={h.name} spec={spec("optic", 1, h.hue)} size={96} stage />
        ))}
        {HUES.map((h) => (
          <Avatar key={`c${h.name}`} spec={spec("critter", 1, h.hue)} size={96} stage />
        ))}
      </div>
      <h2 className="mt-8 mb-2 text-sm font-semibold">Small</h2>
      <div className="flex items-center gap-4" data-block="small">
        {FORMS.map((f) => (
          <Avatar key={f.form} spec={spec(f.form)} size={32} stage />
        ))}
        {FORMS.map((f) => (
          <Avatar key={`m${f.form}`} spec={spec(f.form)} size={48} stage />
        ))}
      </div>
    </div>
  );
}
