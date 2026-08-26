import { useState, useEffect, useRef } from 'react'

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
  const [status, setStatus] = useState('Allow camera access to connect...')
  const [cameraReady, setCameraReady] = useState(false) 
  
  const ws = useRef(null)
  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const peerConnectionRef = useRef(null)
  const localStreamRef = useRef(null)
  const iceCandidateQueue = useRef([])

  const processCandidateQueue = async () => {
    while (iceCandidateQueue.current.length > 0) {
      const candidate = iceCandidateQueue.current.shift()
      try {
        if (peerConnectionRef.current && peerConnectionRef.current.remoteDescription) {
          await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate))
        }
      } catch (err) {
        console.error("Error adding queued ICE candidate:", err)
      }
    }
  }

  useEffect(() => {
    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        localStreamRef.current = stream
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream
        }
        setCameraReady(true) 
      } catch (error) {
        setStatus("Camera permission denied. Cannot connect to server.")
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
      if (remoteVideoRef.current && event.streams[0]) {
        remoteVideoRef.current.srcObject = event.streams[0]
        remoteVideoRef.current.play().catch(error => console.error("Autoplay blocked:", error))
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && ws.current && ws.current.readyState === WebSocket.OPEN) {
        ws.current.send(JSON.stringify({
          type: 'webrtc_ice_candidate',
          candidate: event.candidate
        }))
      }
    }

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        setStatus("Connected to stranger!")
      } else if (pc.iceConnectionState === 'failed') {
        setStatus("Video connection failed. Retrying...")
      }
    }

    return pc
  }

  const closeVideoCall = (clearQueue = true) => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close()
      peerConnectionRef.current = null
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null
    }
    if (clearQueue) {
      iceCandidateQueue.current = []
    }
  }

  useEffect(() => {
    if (!cameraReady) return; 

    ws.current = new WebSocket('wss://omegle-clone-backend-u5bk.onrender.com/ws')

    ws.current.onopen = () => {
      setStatus("Connected! Waiting for backend to assign stranger...")
    }

    ws.current.onmessage = async (event) => {
      const data = JSON.parse(event.data)
      
      if (data.type === 'system') {
        setStatus(data.content)
        
        if (data.content === "Stranger has disconnected.") {
          closeVideoCall(true) 
        }

        if (data.role === 'caller') {
          closeVideoCall(false) 
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
        closeVideoCall(false) 
        peerConnectionRef.current = createPeerConnection()
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(data.offer))
        
        await processCandidateQueue()

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
          await processCandidateQueue()
        }
      }
      else if (data.type === 'webrtc_ice_candidate') {
        if (data.candidate) {
          if (peerConnectionRef.current && peerConnectionRef.current.remoteDescription) {
            try {
              await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(data.candidate))
            } catch (err) {}
          } else {
            iceCandidateQueue.current.push(data.candidate)
          }
        }
      }
    }

    ws.current.onclose = () => {
      setStatus("Disconnected from server.")
      closeVideoCall(true)
    }

    return () => {
      if (ws.current) ws.current.close()
    }
  }, [cameraReady]) 

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
      closeVideoCall(true) 
    }
  }

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#0f172a', color: '#f8fafc', fontFamily: 'system-ui, sans-serif', padding: '2rem 1rem', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <h1 style={{ margin: '0 0 0.5rem 0', fontSize: '2.5rem', fontWeight: '800', background: 'linear-gradient(to right, #3b82f6, #8b5cf6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
        Global Connect
      </h1>
      <p style={{ color: '#94a3b8', marginBottom: '2rem', fontSize: '1.1rem', fontWeight: '500' }}>{status}</p>
      
      {/* Video Grid */}
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '24px', width: '100%', maxWidth: '1000px', marginBottom: '24px' }}>
        <div style={{ flex: '1 1 300px', maxWidth: '450px', position: 'relative' }}>
          <div style={{ position: 'absolute', top: '12px', left: '12px', background: 'rgba(0,0,0,0.6)', padding: '6px 14px', borderRadius: '20px', fontSize: '0.85rem', fontWeight: 'bold', zIndex: 10 }}>You</div>
          <video ref={localVideoRef} autoPlay playsInline muted style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', backgroundColor: '#1e293b', borderRadius: '16px', boxShadow: '0 10px 25px rgba(0,0,0,0.4)' }} />
        </div>
        <div style={{ flex: '1 1 300px', maxWidth: '450px', position: 'relative' }}>
          <div style={{ position: 'absolute', top: '12px', left: '12px', background: 'rgba(0,0,0,0.6)', padding: '6px 14px', borderRadius: '20px', fontSize: '0.85rem', fontWeight: 'bold', zIndex: 10 }}>Stranger</div>
          <video ref={remoteVideoRef} autoPlay playsInline controls style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', backgroundColor: '#1e293b', borderRadius: '16px', boxShadow: '0 10px 25px rgba(0,0,0,0.4)' }} />
        </div>
      </div>

      {/* Chat Section */}
      <div style={{ width: '100%', maxWidth: '924px', backgroundColor: '#1e293b', borderRadius: '16px', padding: '16px', boxShadow: '0 10px 25px rgba(0,0,0,0.4)' }}>
        <div style={{ height: '250px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px', paddingRight: '8px' }}>
          {messages.map((msg, index) => {
            const isSystem = msg.startsWith('[System]');
            const isYou = msg.startsWith('You:');
            return (
              <div key={index} style={{ alignSelf: isSystem ? 'center' : (isYou ? 'flex-end' : 'flex-start'), backgroundColor: isSystem ? 'transparent' : (isYou ? '#3b82f6' : '#334155'), color: isSystem ? '#94a3b8' : '#fff', padding: isSystem ? '4px' : '10px 16px', borderRadius: '18px', maxWidth: '75%', fontSize: isSystem ? '0.85rem' : '1rem' }}>
                {msg.replace(/^(You:|Stranger:|\[System\]:)\s*/, '')}
              </div>
            )
          })}
        </div>

        {/* Inputs */}
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <input type="text" value={inputValue} onChange={(e) => setInputValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendMessage()} placeholder="Type a message..." style={{ flex: '1 1 200px', padding: '14px 20px', borderRadius: '24px', border: 'none', backgroundColor: '#0f172a', color: '#fff', fontSize: '1rem', outline: 'none' }} />
          <button onClick={sendMessage} style={{ padding: '14px 28px', borderRadius: '24px', border: 'none', backgroundColor: '#3b82f6', color: '#fff', fontWeight: 'bold', cursor: 'pointer', transition: 'background 0.2s' }}>Send</button>
          <button onClick={handleSkip} style={{ padding: '14px 28px', borderRadius: '24px', border: 'none', backgroundColor: '#ef4444', color: '#fff', fontWeight: 'bold', cursor: 'pointer', transition: 'background 0.2s' }}>Next</button>
        </div>
      </div>
    </div>
  )
}

export default App