import { createContext,useContext,useEffect,useState,type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api,setToken,type User,type AuthResult } from './api';

type Auth={user:User|null;loading:boolean;login:(username:string,password:string)=>Promise<void>;loginAsGuest:()=>Promise<void>;logout:()=>Promise<void>};
const Context=createContext<Auth|null>(null);
export function AuthProvider({children}:{children:ReactNode}){
  const [user,setUser]=useState<User|null>(null),[loading,setLoading]=useState(true);
  const cache=useQueryClient();
  const clear=()=>{setToken(null);setUser(null);cache.clear();};
  useEffect(()=>{
    let mounted=true;
    api<AuthResult>('/auth/session',{method:'POST'}).then(result=>{if(mounted){setToken(result.accessToken);setUser(result.user);}})
      .catch(()=>{if(mounted)clear();}).finally(()=>{if(mounted)setLoading(false);});
    const expired=()=>clear();window.addEventListener('auth:expired',expired);
    return()=>{mounted=false;window.removeEventListener('auth:expired',expired);};
  },[]);
  function signedIn(result:AuthResult){
    cache.clear();setToken(result.accessToken);setUser(result.user);
  }
  async function login(username:string,password:string){
    signedIn(await api<AuthResult>('/auth/login',{method:'POST',body:JSON.stringify({username,password})}));
  }
  async function loginAsGuest(){
    signedIn(await api<AuthResult>('/auth/guest',{method:'POST'}));
  }
  async function logout(){await api('/auth/logout',{method:'POST'});clear();}
  return <Context.Provider value={{user,loading,login,loginAsGuest,logout}}>{children}</Context.Provider>;
}
export function useAuth(){return useContext(Context)!;}
