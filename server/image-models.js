const defaultRatios = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'];
const defaultResolutions = ['1k', '2k', '4k'];
const qualities = ['low', 'medium', 'high'];
const newerQualities = [...qualities, 'xhigh', 'max'];
const gpt25Prices = {
  low: { '1k': .01, '2k': .02, '4k': .03 },
  medium: { '1k': .024, '2k': .04, '4k': .07 },
  high: { '1k': .09, '2k': .15, '4k': .27 },
  xhigh: { '1k': .16, '2k': .27, '4k': .48 },
  max: { '1k': .36, '2k': .60, '4k': 1 }
};

// Reference prices from WaveSpeed's model documentation; actual billing is provider-controlled.
export const imageModels = {
  'nano-banana-2.1': {
    label: 'Nano Banana 2.1', path: 'google/nano-banana-2.1',
    prices: { '1k': .04, '2k': .06, '4k': .135 }, referenceFee: .002, searchOptions: true
  },
  'nano-banana-2': {
    label: 'Nano Banana 2', path: 'google/nano-banana-2',
    prices: { '1k': .07, '2k': .105, '4k': .14 }, referenceFee: 0, searchOptions: true
  },
  'nano-banana-pro': {
    label: 'Nano Banana Pro', path: 'google/nano-banana-pro',
    prices: { '1k': .14, '2k': .14, '4k': .24 }, referenceFee: 0, searchOptions: false
  },
  'gpt-image-2.5-flare': {
    label: 'GPT Image 2.5 Flare', path: 'openai/gpt-image-2.5-flare',
    qualities: newerQualities, tierPrices: gpt25Prices, referenceFee: .015
  },
  'gpt-image-2.5-sunburst': {
    label: 'GPT Image 2.5 Sunburst', path: 'openai/gpt-image-2.5-sunburst',
    qualities: newerQualities, tierPrices: gpt25Prices, referenceFee: .015
  },
  'gpt-image-2': {
    label: 'GPT Image 2', path: 'openai/gpt-image-2', qualities,
    tierPrices: {
      low: { '1k': .01, '2k': .02, '4k': .03 },
      medium: { '1k': .06, '2k': .10, '4k': .18 },
      high: { '1k': .22, '2k': .40, '4k': .72 }
    }, referenceFee: .01
  },
  'gpt-image-1.5': {
    label: 'GPT Image 1.5', path: 'openai/gpt-image-1.5', qualities,
    aspectRatios: ['1:1', '3:2', '2:3'], resolutions: ['1k'],
    sizeMap: { '1:1': '1024*1024', '3:2': '1536*1024', '2:3': '1024*1536' },
    tierPrices: { low: { square: .01, portrait: .02 }, medium: { square: .04, portrait: .06 }, high: { square: .14, portrait: .21 } },
    // Includes one reference with explicitly selected high input fidelity (+$0.05).
    tierEditPrices: { low: { square: .07, portrait: .08 }, medium: { square: .10, portrait: .12 }, high: { square: .20, portrait: .26 } },
    referenceFee: 0
  }
};
export const defaultModelId = 'nano-banana-2.1';

export function modelConfig() {
  return Object.entries(imageModels).map(([id, model]) => ({ id, label: model.label, prices: model.prices,
    referenceFee: model.referenceFee, tierPrices: model.tierPrices, tierEditPrices: model.tierEditPrices,
    aspectRatios: model.aspectRatios || defaultRatios, resolutions: model.resolutions || defaultResolutions,
    qualities: model.qualities || [], sizeMap: model.sizeMap
  }));
}

export function validModelOptions(model, ratio, resolution, quality) {
  return (model.aspectRatios || defaultRatios).includes(ratio) &&
    (model.resolutions || defaultResolutions).includes(resolution) &&
    (model.qualities ? model.qualities.includes(quality) : !quality);
}

export function modelInput(model, { prompt, ratio, resolution, quality, inputUrl }) {
  return { prompt, ...(inputUrl ? { images: [inputUrl] } : {}),
    ...(model.sizeMap ? { size: model.sizeMap[ratio], background: 'opaque', ...(inputUrl ? { input_fidelity: 'high' } : {}) } : { aspect_ratio: ratio, resolution }),
    ...(model.qualities ? { quality, enable_sync_mode: false, enable_base64_output: false } : {}),
    ...(model.searchOptions ? { enable_web_search: false, enable_image_search: false } : {}), output_format: 'png'
  };
}
