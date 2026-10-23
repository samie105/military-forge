/**
 * A player's avatar in the kit's .avatar disc: their soldier's portrait (owner, 23 Oct: "the character
 * card with the face … the profile of the gamer"), the silhouette with their initial until it lands, and a
 * small bot badge for bots. For the lobby rows, results and anywhere else a row names a player.
 */
import { PlayerPortrait } from '../portrait/Portrait';
import { Icon } from '../ui/Icon';

export function PlayerAvatar({ id, name, bot = false, className }: { id: number; name: string; bot?: boolean; className?: string }) {
  return (
    <span className={['avatar', 'avatar--portrait', className ?? ''].filter(Boolean).join(' ')} aria-hidden="true">
      <PlayerPortrait id={id} name={name} size={64} />
      {bot && (
        <span className="avatar__bot">
          <Icon name="bot" />
        </span>
      )}
    </span>
  );
}
