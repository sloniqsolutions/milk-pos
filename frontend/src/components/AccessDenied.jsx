// @ts-nocheck
import { Lock } from 'lucide-react';

export default function AccessDenied({ message = "You don't have permission to view this page." }) {
  const handleGoToSale = () => {
    window.location.href = '/';
  };

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#FFFFFF',
      gap: 12
    }}>
      <Lock size={52} color="#DC2626" />
      <h2 style={{ fontSize: 20, fontWeight: 700, color: '#111827', margin: 0 }}>
        Access Restricted
      </h2>
      <p style={{ fontSize: 14, color: '#6B7280', margin: 0 }}>{message}</p>
    </div>
  );
}
