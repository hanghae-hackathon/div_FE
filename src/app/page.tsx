'use client';
import 'regenerator-runtime/runtime';
import OpenAI from 'openai';
import { useEffect, useState } from 'react';
import { ChatCompletionMessageParam } from 'openai/resources';
import { searchTrainApi } from '@/api/search';
import { reserveTrainApi } from '@/api/reservation';
import Dictaphone from '@/components/speech-recognition/dictaphone';
import { parseFunctionCall } from '@/util/json';
import Visualizer from '@/components/speech-recognition/waveformgraph';
import ReservationConfirm from '@/components/reservation-confirm';
import axios from 'axios';
import { createChatCompletions, DEFAULT_MESSAGES } from '@/util/gpt';
import SpeechRecognition, {
  useSpeechRecognition,
} from 'react-speech-recognition';
import TranscriptBox from '@/components/transcript';
import Layout from '@/components/layout';
import StartButton from '@/components/startbutton';
import Step5_OCR from '@/components/steps/Step5_OCR';

interface CardInfo {
  card_number: string;
  cvc: string;
  expiry_date: string;
}

const GREETING_MESSAGE = '안녕하세요. 어디에서 어디로 가는 열차를 찾으시나요?';

export default function Home() {
  // Chat GPT 응답
  const [answer, setAnswer] = useState<string | null>(GREETING_MESSAGE);

  // 출발지
  const [departure, setDeparture] = useState<string>('');
  // 도착지
  const [destination, setDestination] = useState<string>('');
  // 출발 날짜 (yyyyMMdd)
  const [departureDate, setDepartureDate] = useState<string>('');
  // 출발시간 (hhmmss)
  const [departureTime, setDepartureTime] = useState<string>('');
  // 도착시간 (hhmmss)
  const [destinationTime, setDestinationTime] = useState<string>('');
  // 대화 내역
  const [messages] = useState<ChatCompletionMessageParam[]>(DEFAULT_MESSAGES);
  // Dictphone
  const { transcript, finalTranscript, listening } = useSpeechRecognition();
  // playing
  const [playing, setPlaying] = useState<boolean>(false);
  // 진행단계
  const [step, setStep] = useState<
    'normal' | 'reservation' | 'payment' | 'end'
  >('normal');

  // todo: isProcessing 상태 추가
  // todo: reservationConfirm 컴포넌트 props 변경(GPT search 응답)

  // OpenAI 객체 생성
  const openai = new OpenAI({
    apiKey: process.env.NEXT_PUBLIC_OPENAI_API_KEY,
    dangerouslyAllowBrowser: true,
  });

  // Chat GPT에게 질문하는 함수
  async function askChatGpt() {
    // 인식된 음성을 대화내역에 추가
    messages.push({
      role: 'user',
      content: finalTranscript,
    });

    // Chat GPT API로 요청 보내기
    const response = await createChatCompletions(messages);
    const responseMessage = response.choices[0].message;
    setAnswer(responseMessage?.content);
    if (responseMessage?.content) {
      await streamResponse(responseMessage?.content, openai, setPlaying);
    }

    // Chat GPT의 응답이 Function Calling인 경우
    if (responseMessage.tool_calls) {
      messages.push(responseMessage);

      for (const toolCall of responseMessage.tool_calls) {
        const parsed = parseFunctionCall(toolCall)?.[0];
        if (!parsed) {
          return;
        }

        const { functionName, parameters } = parsed;

        switch (functionName) {
          case 'saveTrainRoute':
            setDeparture(parameters.departure);
            setDestination(parameters.destination);
            messages.push({
              tool_call_id: toolCall.id,
              role: 'tool',
              name: toolCall.function.name,
              content: JSON.stringify(true),
            });
            break;
          case 'saveDepartureTime':
            const year = new Date().getFullYear();
            const month =
              parameters.month !== ''
                ? parameters.month.toString().padStart(2, '0')
                : (new Date().getMonth() + 1).toString().padStart(2, '0');
            const date =
              parameters.date !== ''
                ? parameters.date.toString().padStart(2, '0')
                : new Date().getDate().toString().padStart(2, '0');

            const ticket = await searchTrainApi({
              date: `${year}${month}${date}`,
              time: parameters.time,
              destination: destination,
              departure: departure,
            });

            if (!ticket) {
              console.error('No ticket found');
              return;
            }

            if (ticket.departureDate) {
              const reservYear = ticket.departureDate.slice(0, 4);
              const reservMonth = ticket.departureDate.slice(4, 6);
              const reservDate = ticket.departureDate.slice(6, 8);
              setDepartureDate(`${reservYear}${reservMonth}${reservDate}`);
            } else {
              setDepartureDate(`${year}${month}${date}`);
            }

            setDepartureTime(ticket.departureTime);
            setDestinationTime(ticket.destinationTime);
            messages.push({
              tool_call_id: toolCall.id,
              role: 'tool',
              name: toolCall.function.name,
              content: JSON.stringify(ticket),
            });
            break;
          case 'reserveTrain':
            setStep('reservation');
            const result = await reserveTrainApi({
              departure: departure,
              destination: destination,
              date: departureDate,
              time: departureTime,
            });
            messages.push({
              tool_call_id: toolCall.id,
              role: 'tool',
              name: toolCall.function.name,
              content: JSON.stringify(result),
            });
            break;
          case 'goToPaymentPage':
            setStep('payment');
          default:
            break;
        }

        const fnResponse = await createChatCompletions(messages);
        const fnAnswer = fnResponse?.choices[0]?.message?.content;
        setAnswer(fnAnswer);
        if (fnAnswer) {
          await streamResponse(fnAnswer, openai, setPlaying);
        }
      }
    }
  }

  // 사용자가 말하는 게 중단되면 Chat GPT로 API 요청을 보냄
  useEffect(() => {
    if (!listening && finalTranscript) {
      askChatGpt();
    }
  }, [listening, finalTranscript]);

  const [photoURL, setPhotoURL] = useState<string | null>(null);
  const [cardInfo, setCardInfo] = useState<CardInfo>();

  const handleCapture = (file: File) => {
    const formData = new FormData();
    formData.append('file', file, 'photo.jpg');

    axios
      .post<CardInfo>('http://localhost:8080/extract_card_info', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      })
      .then(response => {
        setCardInfo(response.data);
        setPhotoURL(URL.createObjectURL(file));
      })
      .catch(error => {
        console.error('Upload error', error);
      });
  };

  const [isOnboard, setIsOnboard] = useState<boolean>(true);
  const handleStartButtonClick = () => {
    if (answer) streamResponse(answer, openai, setPlaying);
    setIsOnboard(false);
  };

  useEffect(() => {
    if (step === 'end') {
      setAnswer('열차 예매가 완료되었습니다. 즐거운 여행 되세요');
      streamResponse(
        '열차 예매가 완료되었습니다. 즐거운 여행 되세요',
        openai,
        setPlaying,
      );
    }
  }, [openai, step]);

  return (
    <main>
      <Layout>
        {isOnboard ? (
          <StartButton onClick={handleStartButtonClick} />
        ) : (
          <>
            <TranscriptBox content={listening ? transcript : answer ?? ''} />
            {step === 'reservation' && (
              <ReservationConfirm
                departure={departure}
                destination={destination}
                departureTime={departureTime}
                departureDate={departureDate}
                destinationTime={destinationTime}
              />
            )}
            {step === 'payment' && (
              <Step5_OCR changeStep={() => setStep('end')} />
            )}
          </>
        )}
        <Visualizer listening={listening} />
        <Dictaphone
          transcript={transcript}
          listening={listening}
          disabled={listening || isOnboard || playing} // TODO: isProcessing
          onClick={() => {
            setAnswer('');
            SpeechRecognition.startListening();
          }}
        />
      </Layout>
    </main>
  );
}

async function streamResponse(
  answer: string,
  openai: OpenAI,
  setPlaying: (playing: boolean) => void,
) {
  if (answer === undefined) {
    return;
  }

  setPlaying(true);

  const response = await openai.audio.speech.create({
    model: 'tts-1',
    voice: 'fable',
    input: answer,
  });

  const reader = response?.body?.getReader();
  if (reader) {
    const stream = new ReadableStream({
      start(controller) {
        function push() {
          reader.read().then(({ done, value }) => {
            if (done) {
              controller.close();
              return;
            }
            controller.enqueue(value);
            push();
          });
        }
        push();
      },
    });

    const audioBlob = await new Response(stream).blob();
    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(audioUrl);
    audio.playbackRate = 1.1;
    console.log('answer:', answer);
    audio.play().then(() => {
      setTimeout(
        () => {
          setPlaying(false);
        },
        1000 * (audio.duration + 1),
      );
    });
  }
}
