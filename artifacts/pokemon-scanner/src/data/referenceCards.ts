import { loadImage, imageToGrayscale32x32 } from '../utils/canvasUtils';
import { computePHash } from '../utils/phash';

export interface ReferenceCard {
  id: string;
  name: string;
  set: string;
  number: string;
  imageUrl: string;
  hash?: bigint;
}

export const REFERENCE_CARDS: ReferenceCard[] = [
  { id: 'base1-4',  name: 'Charizard',   set: 'Base Set', number: '4/102',  imageUrl: 'https://images.pokemontcg.io/base1/4_hires.png' },
  { id: 'base1-2',  name: 'Blastoise',   set: 'Base Set', number: '2/102',  imageUrl: 'https://images.pokemontcg.io/base1/2_hires.png' },
  { id: 'base1-15', name: 'Venusaur',    set: 'Base Set', number: '15/102', imageUrl: 'https://images.pokemontcg.io/base1/15_hires.png' },
  { id: 'base1-10', name: 'Mewtwo',      set: 'Base Set', number: '10/102', imageUrl: 'https://images.pokemontcg.io/base1/10_hires.png' },
  { id: 'base1-58', name: 'Pikachu',     set: 'Base Set', number: '58/102', imageUrl: 'https://images.pokemontcg.io/base1/58_hires.png' },
  { id: 'base1-14', name: 'Raichu',      set: 'Base Set', number: '14/102', imageUrl: 'https://images.pokemontcg.io/base1/14_hires.png' },
  { id: 'base1-5',  name: 'Clefairy',    set: 'Base Set', number: '5/102',  imageUrl: 'https://images.pokemontcg.io/base1/5_hires.png' },
  { id: 'base1-6',  name: 'Gyarados',    set: 'Base Set', number: '6/102',  imageUrl: 'https://images.pokemontcg.io/base1/6_hires.png' },
  { id: 'base1-1',  name: 'Alakazam',    set: 'Base Set', number: '1/102',  imageUrl: 'https://images.pokemontcg.io/base1/1_hires.png' },
  { id: 'base1-8',  name: 'Machamp',     set: 'Base Set', number: '8/102',  imageUrl: 'https://images.pokemontcg.io/base1/8_hires.png' },
  { id: 'base1-9',  name: 'Magneton',    set: 'Base Set', number: '9/102',  imageUrl: 'https://images.pokemontcg.io/base1/9_hires.png' },
  { id: 'base1-11', name: 'Nidoking',    set: 'Base Set', number: '11/102', imageUrl: 'https://images.pokemontcg.io/base1/11_hires.png' },
  { id: 'base1-13', name: 'Chansey',     set: 'Base Set', number: '13/102', imageUrl: 'https://images.pokemontcg.io/base1/13_hires.png' },
  { id: 'base1-16', name: 'Zapdos',      set: 'Base Set', number: '16/102', imageUrl: 'https://images.pokemontcg.io/base1/16_hires.png' },
  { id: 'base1-7',  name: 'Hitmonchan',  set: 'Base Set', number: '7/102',  imageUrl: 'https://images.pokemontcg.io/base1/7_hires.png' },
];

export async function initReferenceCards() {
  const promises = REFERENCE_CARDS.map(async (card) => {
    if (!card.hash) {
      try {
        const img = await loadImage(card.imageUrl);
        const imgData = imageToGrayscale32x32(img);
        card.hash = computePHash(imgData);
      } catch (err) {
        console.warn("Failed to load/hash card", card.id, err);
        card.hash = 0n;
      }
    }
  });
  await Promise.all(promises);
}
