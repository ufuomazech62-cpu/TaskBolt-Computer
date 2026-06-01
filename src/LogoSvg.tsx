import { useId } from 'react'

interface LogoSvgProps {
  size?: number
  animated?: boolean
  status?: 'idle' | 'thinking' | 'executing' | 'typing'
  className?: string
}

export default function LogoSvg({ size = 48, animated = false, status = 'idle', className = '' }: LogoSvgProps) {
  const uid = useId().replace(/:/g, '')
  const animClass = animated ? `logo-orb logo-${status}` : 'logo-orb'

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`${animClass} ${className}`}
      style={{ overflow: 'visible' }}
    >
      <defs>
        <radialGradient id={`orb${uid}`} cx="35%" cy="25%">
          <stop offset="0%" stopColor="#FFD54A" />
          <stop offset="20%" stopColor="#FF9A1F" />
          <stop offset="50%" stopColor="#FF2F92" />
          <stop offset="80%" stopColor="#C026FF" />
          <stop offset="100%" stopColor="#6D28FF" />
        </radialGradient>
        <radialGradient id={`glass${uid}`} cx="30%" cy="20%">
          <stop offset="0%" stopColor="white" stopOpacity={0.85} />
          <stop offset="100%" stopColor="white" stopOpacity={0} />
        </radialGradient>
      </defs>

      {/* Head group — tilts/wags */}
      <g className="logo-head" style={{ transformOrigin: '256px 256px' }}>
        {/* Main orb */}
        <circle cx="256" cy="256" r="160" fill={`url(#orb${uid})`} />
        {/* Glass highlight */}
        <ellipse cx="215" cy="195" rx="95" ry="65" fill={`url(#glass${uid})`} opacity={0.7} />
        {/* Bottom shine */}
        <ellipse cx="250" cy="350" rx="115" ry="45" fill="white" opacity={0.12} />
        
        {/* Eyes group — blinks together */}
        <g className="logo-eyes" style={{ transformOrigin: '276px 207px' }}>
          {/* Left eye */}
          <ellipse className="logo-eye" cx="231" cy="222" rx="26" ry="47" fill="white" opacity={0.95} />
          {/* Right eye */}
          <ellipse className="logo-eye" cx="321" cy="212" rx="26" ry="47" fill="white" opacity={0.95} />
        </g>
      </g>
    </svg>
  )
}
