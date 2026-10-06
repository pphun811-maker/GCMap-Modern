import type { BaseMode } from '../map/styleFactory';
import type { Lang, Strings } from '../i18n/strings';

interface Props {
  base: BaseMode;
  onBase: (m: BaseMode) => void;
  globeOn: boolean;
  onGlobe: (v: boolean) => void;
  onReset: () => void;
  lang: Lang;
  onLang: (l: Lang) => void;
  labelsOn: boolean;
  onLabels: (v: boolean) => void;
  t: Strings;
}

export function TopRightControls({ base, onBase, globeOn, onGlobe, onReset, lang, onLang, labelsOn, onLabels, t }: Props) {
  return (
    <div className="map-controls">
      <div className="seg">
        <button className={base === 'vector' ? 'active' : ''} onClick={() => onBase('vector')}>
          {t.vector}
        </button>
        <button className={base === 'satellite' ? 'active' : ''} onClick={() => onBase('satellite')}>
          {t.satellite}
        </button>
      </div>
      <div className="seg">
        <button
          className={globeOn ? 'active' : ''}
          aria-pressed={globeOn}
          title={t.globeTip}
          onClick={() => onGlobe(!globeOn)}
        >
          {t.globe}
        </button>
        <button title={t.resetViewTip} onClick={onReset}>
          {t.resetView}
        </button>
      </div>
      <div className="seg">
        <button
          className={labelsOn ? 'active' : ''}
          aria-pressed={labelsOn}
          onClick={() => onLabels(!labelsOn)}
        >
          {t.labels}
        </button>
      </div>
      <div className="seg">
        <button className={lang === 'zh' ? 'active' : ''} onClick={() => onLang('zh')}>
          中
        </button>
        <button className={lang === 'en' ? 'active' : ''} onClick={() => onLang('en')}>
          EN
        </button>
      </div>
    </div>
  );
}
