import { useState } from 'react';
import { Plus, Check } from 'lucide-react';
import { usePOS } from '@/lib/POSContext';
import { useSettings } from '@/lib/SettingsContext';
import litre1 from '@/assets/litre1.png';
import litre2 from '@/assets/litre2.png';
import litre5 from '@/assets/litre5.png';

const BLUE      = '#1B4C82';
const BLUE_DARK = '#123A66';
const BLUE_TINT = '#EAF2FB';
const CREAM     = '#FFFDE0';
const GOLD_LINE = 'linear-gradient(90deg, #F59E0B 0%, #1B4C82 100%)';

interface MenuItem {
  id: number;
  name: string;
  category: string;
  price: number;
  image_url?: string;
  has_variants?: number;
  variants?: { id: number; label: string; price: number; sort_order: number }[];
}

interface AddPayload {
  id: number;
  name: string;
  price: number;
  isDeal?: boolean;
  variant_id?: number | null;
  qty?: number;
}

interface MenuPanelProps {
  onAddToCart: (item: AddPayload) => void;
  search: string;
}

function getItemImage(item: MenuItem): string {
  if (item.image_url) return item.image_url;
  const name = item.name.toLowerCase();
  if (name.includes('0.5') || name.includes('half')) return litre5;
  if (name.includes('2') || name.includes('two')) return litre2;
  if (name.includes('1') || name.includes('one') || name.includes('litre')) return litre1;
  return litre1;
}

export default function MenuPanel({ onAddToCart, search }: MenuPanelProps) {
  const { menuItems } = usePOS();

  const filteredItems = menuItems.filter(item => {
    if (search) return item.name.toLowerCase().includes(search.toLowerCase());
    return true;
  });

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#F7F9FC' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
          gridAutoRows: '235px',
          gap: 16,
          padding: 20,
          overflowY: 'auto',
          flex: 1,
          alignContent: 'start',
        }}
      >
        {filteredItems.map(item => (
          <ItemCard
            key={item.id}
            item={item}
            onAdd={() => onAddToCart(item)}
          />
        ))}
      </div>
    </div>
  );
}

function ItemCard({ item, onAdd }: { item: MenuItem; onAdd: () => void }) {
  const [imgError, setImgError] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [justAdded, setJustAdded] = useState(false);
  const { formatMoney } = useSettings();

  const handleClick = () => {
    setPressed(true);
    setJustAdded(true);
    onAdd();
    setTimeout(() => setPressed(false), 150);
    setTimeout(() => setJustAdded(false), 600);
  };

  const hasVariants = item.has_variants === 1 && item.variants && item.variants.length > 0;
  const lowestPrice = hasVariants ? Math.min(...item.variants.map(v => v.price)) : item.price;

  return (
    <div
      onClick={handleClick}
      style={{
        transform: pressed ? 'scale(0.97)' : 'translateY(0)',
        background: '#FFFFFF',
        border: '1.5px solid #E5E9F0',
        borderRadius: 14,
        boxShadow: '0 2px 6px rgba(16,40,80,0.06)',
        overflow: 'hidden',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        cursor: 'pointer',
        transition: 'all 160ms cubic-bezier(0.16, 1, 0.3, 1)',
        position: 'relative',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.boxShadow = '0 8px 22px rgba(27,76,130,0.14)';
        e.currentTarget.style.borderColor = BLUE;
        e.currentTarget.style.transform = 'translateY(-3px)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.boxShadow = '0 2px 6px rgba(16,40,80,0.06)';
        e.currentTarget.style.borderColor = '#E5E9F0';
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      {/* Top Banner: Dark Navy Gradient with Category Tag & Image */}
      <div
        style={{
          height: 125,
          width: '100%',
          background: 'linear-gradient(145deg, #123A66 0%, #1B4C82 60%, #2A629A 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Subtle decorative background glow circles */}
        <div style={{
          position: 'absolute',
          top: -20,
          right: -20,
          width: 80,
          height: 80,
          borderRadius: '50%',
          background: 'rgba(255,255,255,0.08)',
        }} />

        {/* Category Badge */}
        <div style={{
          position: 'absolute',
          top: 10,
          left: 10,
          background: 'rgba(15,23,32,0.6)',
          backdropFilter: 'blur(4px)',
          color: '#FFFFFF',
          fontSize: 10.5,
          fontWeight: 700,
          padding: '3px 8px',
          borderRadius: 6,
          letterSpacing: '0.4px',
          textTransform: 'uppercase',
          border: '1px solid rgba(255,255,255,0.15)',
        }}>
          {item.category || 'Milk'}
        </div>

        {/* Product Image / Icon */}
        {!imgLoaded && !imgError && (
          <div style={{ width: 60, height: 75, borderRadius: 8, background: 'rgba(255,255,255,0.2)' }} />
        )}
        {imgError ? (
          <div style={{ fontSize: 44 }}>🥛</div>
        ) : (
          <img
            src={getItemImage(item)}
            alt={item.name}
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            onError={() => setImgError(true)}
            style={{
              height: 95,
              objectFit: 'contain',
              opacity: imgLoaded ? 1 : 0,
              transition: 'opacity 0.3s ease',
              filter: 'drop-shadow(0 4px 8px rgba(0,0,0,0.25))'
            }}
          />
        )}
      </div>

      {/* Aesthetically drawn dual-color decorative line */}
      <div style={{
        height: 3,
        width: '100%',
        background: GOLD_LINE,
        flexShrink: 0,
      }} />

      {/* Card Body with Product Name, Sizes & Price */}
      <div style={{
        padding: '12px 14px 10px',
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: '#FFFFFF',
        position: 'relative'
      }}>
        {/* Floating Quick Add Button */}
        <button
          onClick={(e) => { e.stopPropagation(); handleClick(); }}
          title="Add to cart"
          style={{
            position: 'absolute',
            right: 12,
            top: -18,
            width: 34,
            height: 34,
            borderRadius: '50%',
            background: justAdded ? '#16A34A' : BLUE,
            border: '2.5px solid #FFFFFF',
            color: '#FFFFFF',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 3px 8px rgba(27,76,130,0.3)',
            transition: 'all 140ms ease',
          }}
          onMouseEnter={e => { if (!justAdded) e.currentTarget.style.background = BLUE_DARK; }}
          onMouseLeave={e => { if (!justAdded) e.currentTarget.style.background = BLUE; }}
        >
          {justAdded ? <Check size={16} /> : <Plus size={17} />}
        </button>

        {/* Title */}
        <div>
          <div style={{
            fontSize: 14,
            fontWeight: 700,
            color: '#0F1720',
            lineHeight: '1.25',
            paddingRight: 28,
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}>
            {item.name}
          </div>

          {/* Variant pills if any */}
          {hasVariants && (
            <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
              {item.variants.slice(0, 3).map(v => (
                <span key={v.id} style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: BLUE,
                  background: BLUE_TINT,
                  padding: '1px 6px',
                  borderRadius: 4,
                }}>
                  {v.label}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Price Tag */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 4 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: '#8A95A5', textTransform: 'uppercase' }}>
              {hasVariants ? 'From' : 'Price'}
            </div>
            <div style={{ fontSize: 15, fontWeight: 800, color: BLUE_DARK }}>
              {formatMoney(lowestPrice)}
            </div>
          </div>

          {hasVariants && (
            <span style={{ fontSize: 11, fontWeight: 600, color: '#D97706', background: CREAM, padding: '2px 6px', borderRadius: 4, border: '1px solid #FDE68A' }}>
              {item.variants.length} Sizes
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
