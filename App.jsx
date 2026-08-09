import { useState, useEffect, useRef } from 'react'

// Upgraded servers with STUN (for local connections) and TURN (for global firewalls)
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ]
}

function App() {
  const [messages, setMessages] = useState([])
  const [inputValue, setInputValue] = useState('')
  const [status, setStatus] = useState('Connecting...')
  
  const ws = useRef(null)
  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const peerConnectionRef = useRef(null)
  const localStreamRef = useRef(null)
  const iceCandidateQueue = useRef([]) // Holds network paths that arrive too early

  // 1. Setup Camera on Load
  useEffect(() => {
    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        localStreamRef.current = stream
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream
        }
      } catch (error) {
        console.error("Error accessing camera:", error)
        setStatus("Camera permission denied.")
      }
    }
    startCamera()
  }, [])

  const createPeerConnection = () => {
    const pc = new RTCPeerConnection(ICE_SERVERS)
    
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current)
      })
    }

    pc.ontrack = (event) => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0]
        
        // Force the browser to play the video the second it arrives
        remoteVideoRef.current.play().catch(error => {
          console.error("Autoplay was blocked by the browser:", error)
        })
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && ws.current) {
        ws.current.send(JSON.stringify({
          type: 'webrtc_ice_candidate',
          candidate: event.candidate
        }))
      }
    }

    return pc
  }

  const closeVideoCall = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close()
      peerConnectionRef.current = null
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null
    }
    iceCandidateQueue.current = [] // Clear the queue on disconnect
  }

  // 2. Setup WebSocket Matchmaker & WebRTC Signaling
  useEffect(() => {
    ws.current = new WebSocket('wss://omegle-clone-backend-u5bk.onrender.com/ws')

    ws.current.onopen = () => {
      setStatus("Connected! Waiting for backend to assign stranger...")
    }

    ws.current.onmessage = async (event) => {
      const data = JSON.parse(event.data)
      
      if (data.type === 'system') {
        setStatus(data.content)
        setMessages((prev) => [...prev, `[System]: ${data.content}`])
        
        if (data.content === "Stranger has disconnected.") {
          closeVideoCall()
        }

        if (data.role === 'caller') {
          peerConnectionRef.current = createPeerConnection()
          const offer = await peerConnectionRef.current.createOffer()
          await peerConnectionRef.current.setLocalDescription(offer)
          
          ws.current.send(JSON.stringify({
            type: 'webrtc_offer',
            offer: offer
          }))
        }
      } 
      else if (data.type === 'chat_message') {
        setMessages((prev) => [...prev, `${data.sender}: ${data.content}`])
      }
      else if (data.type === 'webrtc_offer') {
        peerConnectionRef.current = createPeerConnection()
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(data.offer))
        
        const answer = await peerConnectionRef.current.createAnswer()
        await peerConnectionRef.current.setLocalDescription(answer)
        
        ws.current.send(JSON.stringify({
          type: 'webrtc_answer',
          answer: answer
        }))
      }
      else if (data.type === 'webrtc_answer') {
        if (peerConnectionRef.current) {
          await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(data.answer))
          
          // Process any network paths that arrived too early
          while (iceCandidateQueue.current.length > 0) {
            const candidate = iceCandidateQueue.current.shift()
            await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate))
          }
        }
      }
      else if (data.type === 'webrtc_ice_candidate') {
        if (peerConnectionRef.current && data.candidate) {
          if (peerConnectionRef.current.remoteDescription) {
             // If the call is answered, connect the video path
            await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(data.candidate))
          } else {
             // If the call is still connecting, save the path for later
            iceCandidateQueue.current.push(data.candidate)
          }
        }
      }
    }

    ws.current.onclose = () => {
      setStatus("Disconnected from server.")
      closeVideoCall()
    }

    return () => {
      if (ws.current) ws.current.close()
    }
  }, [])

  const sendMessage = () => {
    if (ws.current && inputValue !== '') {
      ws.current.send(JSON.stringify({ type: 'chat_message', content: inputValue }))
      setMessages((prev) => [...prev, `You: ${inputValue}`])
      setInputValue('') 
    }
  }

  const handleSkip = () => {
    if (ws.current) {
      ws.current.send(JSON.stringify({ type: 'skip' }))
      setMessages([]) 
      setStatus("Skipping... looking for someone new.")
      closeVideoCall()
    }
  }

  return (
    <div style={{ padding: '1rem', fontFamily: 'sans-serif', maxWidth: '800px', margin: '0 auto' }}>
      <h1 style={{ textAlign: 'center' }}>Omegle Clone Matchmaker</h1>
      <h3 style={{ color: 'blue', textAlign: 'center' }}>Status: {status}</h3>
      
      {/* Mobile-responsive Flexbox for Videos */}
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '20px', marginBottom: '20px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', maxWidth: '300px' }}>
          <h4 style={{ margin: '0 0 10px 0' }}>You</h4>
          <video ref={localVideoRef} autoPlay playsInline muted style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', backgroundColor: '#222', borderRadius: '8px' }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', maxWidth: '300px' }}>
          <h4 style={{ margin: '0 0 10px 0' }}>Stranger</h4>
          {/* Controls added here to bypass Apple's Low Power Mode */}
          <video ref={remoteVideoRef} autoPlay playsInline controls style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', backgroundColor: '#222', borderRadius: '8px' }} />
        </div>
      </div>

      <div style={{ maxWidth: '620px', margin: '0 auto' }}>
        <div style={{ border: '1px solid #ccc', padding: '10px', height: '200px', overflowY: 'scroll', marginBottom: '10px' }}>
          {messages.map((msg, index) => (
            <p key={index} style={{ margin: '5px 0' }}>{msg}</p>
          ))}
        </div>

        {/* Mobile-responsive Chat Input Row */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
          <input type="text" value={inputValue} onChange={(e) => setInputValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendMessage()} placeholder="Type a message..." style={{ padding: '8px', flex: '1', minWidth: '150px' }} />
          <button onClick={sendMessage} style={{ padding: '8px 20px' }}>Send</button>
          <button onClick={handleSkip} style={{ padding: '8px 20px', backgroundColor: '#ff4444', color: 'white', border: 'none', cursor: 'pointer' }}>Next / Skip</button>
        </div>
      </div>
    </div>
  )
}

export default App